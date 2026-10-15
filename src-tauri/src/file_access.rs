//! 本地文件访问（含路径权限）
//!
//! 技术方案第 6 节第 3 项是「本地文件读取**和路径权限**」—— 路径权限是需求本身的一部分，
//! 不是可选的加固。所以这个模块的核心不是「怎么读文件」，而是**怎么保证只读到授权的范围里**。
//!
//! ## 四道防线
//!
//! 1. **前端只表达相对路径。** 命令收的是「相对授权目录的路径」，
//!    绝对路径一律拒收。这样前端**连表达「读 D:\别的盘」这件事的能力都没有** ——
//!    比「收绝对路径再检查它是否在范围内」更难绕过，因为攻击面小了一整类。
//! 2. **逐段检查，`..` 直接拒。** 不做「先拼接再判断」那种写法 ——
//!    那种写法的正确性依赖路径拼接的细节，很容易在某个平台上被绕过。
//! 3. **路径上任何一段是符号链接就拒。** 见 `ensure_no_symlink` 里的实测记录 ——
//!    这一条是**靠不住的假设被测试推翻之后才加的**。
//! 4. **规范化之后比对前缀**，作为兜底。
//!
//! ## 关于符号链接：一度写错的地方
//!
//! 最初这里只写了前三道里的 1、2、4，注释里断言「只有 canonicalize 之后比对前缀，
//! 才能挡住符号链接指向目录外」。**这句话在 Windows 上不成立** ——
//! 单元测试实测：`std::fs::canonicalize` 对「最后一段是符号链接」的情况
//! 可能原样返回链接自身的路径，而不是它指向的目标。于是「链接指向目录外」
//! 会被误判成安全。
//!
//! 修法不是去研究 `canonicalize` 在什么条件下解析、什么条件下不解析
//! （那种正确性依赖平台行为细节，随时可能变），而是干脆
//! **不让路径经过任何符号链接** —— 规则简单、跨平台一致，而且对用户解释得清楚。
//!
//! ## 读的是文本，不是字节
//!
//! 这个应用要的是「能放进对话里的内容」，所以：
//! - 超过上限的文件**截断**而不是拒绝（大日志的前几段通常就有用），并如实标记；
//! - 不是 UTF-8 的文件明确说清「这不是文本」，而不是塞一堆乱码给模型。
//!
//! 已知限制：只认 UTF-8。中文 Windows 上一些旧 .txt 是 GBK，会被判为「不是文本」。
//! 没有做编码探测是个取舍 —— 见 README 的「已知缺口」。

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use crate::models::{FileContent, FileEntry, RecentRead};

/// 单次读取的体积上限。再大就不该整段塞进对话了。
pub const MAX_READ_BYTES: u64 = 256 * 1024;

/// 列目录时每层最多返回多少条
pub const MAX_LIST_ENTRIES: usize = 200;

/// 最近读取记录保留多少条
pub const RECENT_READ_LIMIT: usize = 10;

// ---------------------------------------------------------------------------
// 路径权限
// ---------------------------------------------------------------------------

/// 校验一个待授权的目录。
///
/// 要求绝对路径、必须存在、必须是目录，并返回规范化后的形式 ——
/// 存规范化形式是为了让后面的前缀比对有一个稳定的基准
/// （Windows 上 `D:\a\..\b` 和 `D:\b` 必须等价）。
pub fn validate_authorized_root(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请先选择一个目录。".to_string());
    }

    let candidate = Path::new(trimmed);
    if !candidate.is_absolute() {
        return Err("请填写完整的绝对路径，例如 D:\\笔记。".to_string());
    }

    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("这个路径打不开：{error}"))?;

    if !canonical.is_dir() {
        return Err("这个路径不是一个目录。".to_string());
    }

    Ok(canonical)
}

/// 授权范围过宽的提醒。**只提醒、不阻断** —— 用户的机器他自己做主，
/// 但「把整个 C 盘授权出去」多半是误操作，值得说一句。
pub fn broad_scope_warning(root: &Path) -> Option<String> {
    // 盘符根目录（C:\、D:\ 之类）
    if root.parent().is_none() {
        return Some(
            "你授权的是整个磁盘。助手可以读取这个盘上所有能被程序打开的文件，\
             建议换成具体的某个文件夹。"
                .to_string(),
        );
    }

    // 常见的系统目录
    let lowered = root.to_string_lossy().to_lowercase();
    let sensitive = [
        "\\windows",
        "\\program files",
        "\\program files (x86)",
        "\\programdata",
        "\\users\\public",
    ];
    if sensitive.iter().any(|part| lowered.ends_with(part)) {
        return Some("这是系统目录，里面通常没有你想给助手看的东西，建议换个文件夹。".to_string());
    }

    None
}

/// 路径上任何一段是符号链接就拒。
///
/// 实测记录（Windows，2026-10-16）：`std::fs::canonicalize` 对最后一段是符号链接的
/// 情况**不保证**解析到目标 —— 测试里它原样返回了链接自身的路径，
/// 于是「链接指向目录外」会被前缀比对误判为安全。
///
/// 与其去研究 canonicalize 在什么条件下解析，不如直接不许路径经过符号链接：
/// 规则简单、跨平台一致、对用户也解释得清楚。
fn ensure_no_symlink(root: &Path, relative: &Path) -> Result<(), String> {
    ensure_no_symlink_with(root, relative, &|candidate| {
        let metadata = std::fs::symlink_metadata(candidate)
            .map_err(|error| format!("读不到这个文件：{error}"))?;
        Ok(metadata.file_type().is_symlink())
    })
}

/// 同上，但「这个路径是不是链接」由调用方给。
///
/// 之所以多这一层：本机跑测试的环境**创建不出真实符号链接**
/// （`std::fs::symlink_file` 返回 Ok，产物却不是重分析点 —— 关掉沙箱也一样）。
/// 那样一来这段守着安全边界的代码就完全测不到了。
/// 把探测动作抽成参数之后，「有没有逐段检查、最后一段查不查」这些**逻辑**
/// 就能稳定地测，真实符号链接的端到端用例只在支持的环境里跑。
fn ensure_no_symlink_with(
    root: &Path,
    relative: &Path,
    is_link: &dyn Fn(&Path) -> Result<bool, String>,
) -> Result<(), String> {
    let mut current = root.to_path_buf();

    for component in relative.components() {
        let Component::Normal(name) = component else {
            continue;
        };

        current.push(name);
        if is_link(&current)? {
            return Err("这个路径经过了符号链接，可能指向授权目录之外，已拒绝。\
                 如果确实需要读它指向的文件，请把那个文件所在的文件夹单独授权。"
                .to_string());
        }
    }

    Ok(())
}

/// 把「相对授权目录的路径」解析成真实路径，并确认它没有跑出授权目录。
///
/// 这是整个功能的安全核心。四道检查按顺序执行，每道对应一类绕过手法：
/// 绝对路径 / 盘符前缀、`..` 上跳、路径经过符号链接、以及规范化之后的兜底比对。
pub fn resolve_within_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let trimmed = relative.trim();
    if trimmed.is_empty() {
        return Err("要读的文件不能为空。".to_string());
    }

    let candidate = Path::new(trimmed);

    // 第一道：绝对路径直接拒。前端不该有表达「读别处」的途径。
    if candidate.is_absolute() {
        return Err("只允许读取授权目录里的文件，请用相对路径。".to_string());
    }

    // 第二道：逐段检查。`Prefix`（C: / \\?\ / \\server）和 `RootDir` 也一并拒掉，
    // 它们能让 `C:foo` 这种「看着像相对路径、实际是盘符相对」的写法溜过去。
    for component in candidate.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err("路径里不能出现「..」，请直接给出授权目录内的相对路径。".to_string());
            }
            _ => {
                return Err("这个路径形式不被支持，请用普通的相对路径。".to_string());
            }
        }
    }

    // 第三道：路径上不许出现符号链接。
    // 前两道都是字符串层面的，挡不住「目录里放个链接指向外面」。
    ensure_no_symlink(root, candidate)?;

    // 第四道：规范化之后比对前缀，作为兜底。
    // 到这里路径已经完全由我们构造，这一道是为了挡住「连根目录本身都是链接」之类的边角情况。
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("授权目录现在打不开了：{error}"))?;

    let target = canonical_root.join(candidate);
    let canonical_target = target
        .canonicalize()
        .map_err(|error| format!("读不到这个文件：{error}"))?;

    if !canonical_target.starts_with(&canonical_root) {
        return Err("这个路径指向授权目录之外，已拒绝。".to_string());
    }

    Ok(canonical_target)
}

// ---------------------------------------------------------------------------
// 读取与列目录
// ---------------------------------------------------------------------------

/// 读一个文本文件。`relative` 是相对授权目录的路径。
pub fn read_text_file(root: &Path, relative: &str) -> Result<FileContent, String> {
    let path = resolve_within_root(root, relative)?;

    let metadata = std::fs::metadata(&path).map_err(|error| format!("读不到这个文件：{error}"))?;
    if !metadata.is_file() {
        return Err("这是一个目录，不是文件。".to_string());
    }

    let size = metadata.len();

    // 大文件截断而不是拒绝：前 256 KB 通常已经够回答问题了。
    // 用 take 限制读取量，避免为了截断反而先把整个文件读进内存。
    let bytes = {
        use std::io::Read;
        let file =
            std::fs::File::open(&path).map_err(|error| format!("打不开这个文件：{error}"))?;
        let mut buffer = Vec::new();
        file.take(MAX_READ_BYTES)
            .read_to_end(&mut buffer)
            .map_err(|error| format!("读取失败：{error}"))?;
        buffer
    };

    let truncated = size > MAX_READ_BYTES;

    // 只认 UTF-8。不是文本时明确说清，而不是把乱码丢给模型。
    let content = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            let valid_up_to = error.utf8_error().valid_up_to();

            // 截断是按字节切的，可能刚好切在一个多字节字符中间 ——
            // 那不是「这个文件不是文本」，去掉不完整的尾巴就是一段完整的文本。
            // 只在确实发生了截断时这么处理：没截断却解不出 UTF-8，说明它真的不是文本。
            if !truncated || valid_up_to == 0 {
                return Err(
                    "这个文件不是 UTF-8 文本，可能是二进制文件，或者是旧编码（如 GBK）的中文文本。"
                        .to_string(),
                );
            }

            let mut bytes = error.into_bytes();
            bytes.truncate(valid_up_to);
            String::from_utf8(bytes).expect("按 valid_up_to 截断之后必然是合法 UTF-8")
        }
    };

    log::info!("读取授权目录内的文件（{size} 字节，截断：{truncated}）");

    Ok(FileContent {
        relative_path: relative.trim().to_string(),
        content,
        bytes: size,
        truncated,
    })
}

/// 列出某一层的内容。`relative_dir` 为空表示授权目录本身。
///
/// 只列一层，不递归 —— 递归遍历整个目录树既慢又会把「授权了一个大目录」
/// 变成一次代价很高的操作。
pub fn list_directory(root: &Path, relative_dir: &str) -> Result<Vec<FileEntry>, String> {
    let dir = if relative_dir.trim().is_empty() {
        root.canonicalize()
            .map_err(|error| format!("授权目录现在打不开了：{error}"))?
    } else {
        resolve_within_root(root, relative_dir)?
    };

    if !dir.is_dir() {
        return Err("这不是一个目录。".to_string());
    }

    let entries = std::fs::read_dir(&dir).map_err(|error| format!("打不开这个目录：{error}"))?;

    let mut result = Vec::new();
    for entry in entries.flatten() {
        if result.len() >= MAX_LIST_ENTRIES {
            break;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        // 跳过隐藏项：它们几乎总是配置或系统文件，列出来只会干扰
        if name.starts_with('.') {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };

        let child_relative = if relative_dir.trim().is_empty() {
            name.clone()
        } else {
            format!("{}/{}", relative_dir.trim().trim_end_matches('/'), name)
        };

        result.push(FileEntry {
            relative_path: child_relative,
            name,
            is_directory: metadata.is_dir(),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
        });
    }

    // 目录在前，然后按名字排 —— 稳定的顺序才好在界面上找东西
    result.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(result)
}

// ---------------------------------------------------------------------------
// 读取审计
// ---------------------------------------------------------------------------

/// 最近读过哪些文件。
///
/// **刻意不持久化。** 这是一份「刚刚发生了什么」的现场记录，
/// 落到磁盘就变成了对用户阅读史的长期保存 —— 那是另一件事，不该顺手做掉。
#[derive(Debug, Default)]
pub struct ReadAudit {
    entries: Mutex<VecDeque<RecentRead>>,
}

impl ReadAudit {
    pub fn record(&self, relative_path: &str, bytes: u64) {
        let Ok(mut entries) = self.entries.lock().map_err(|error| error.into_inner()) else {
            return;
        };

        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);

        entries.push_front(RecentRead {
            relative_path: relative_path.to_string(),
            bytes,
            at,
        });

        while entries.len() > RECENT_READ_LIMIT {
            entries.pop_back();
        }
    }

    pub fn recent(&self) -> Vec<RecentRead> {
        match self.entries.lock() {
            Ok(entries) => entries.iter().cloned().collect(),
            Err(error) => error.into_inner().iter().cloned().collect(),
        }
    }

    /// 撤销授权时一并清掉：授权都没了，再留着「刚才读过什么」没有意义
    pub fn clear(&self) {
        match self.entries.lock() {
            Ok(mut entries) => entries.clear(),
            Err(error) => error.into_inner().clear(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 造一个临时目录树。用它而不是固定路径，避免依赖开发机上的实际文件。
    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("ai-assistant-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("临时目录应该能建");
            Self { root }
        }

        fn write(&self, relative: &str, content: &str) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("父目录应该能建");
            }
            fs::write(&path, content).expect("测试文件应该能写");
            path
        }

        fn mkdir(&self, relative: &str) -> PathBuf {
            let path = self.root.join(relative);
            fs::create_dir_all(&path).expect("目录应该能建");
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// 创建一个符号链接，并确认它**真的是**符号链接。
    ///
    /// 返回 false 表示当前环境造不出真实链接，用例应当跳过。
    ///
    /// 实测（Windows，2026-10-16）：有的环境里 `symlink_file` / `symlink_dir` 会返回 `Ok`，
    /// 但产物根本不是重分析点（`read_link` 报「此文件或目录不是一个重分析点」）。
    /// 所以**不能只看返回值** —— 必须回头确认，否则用例会在一个「其实没造出链接」
    /// 的环境里假装通过，那比没有测试更糟。
    fn symlink_or_skip(create: impl FnOnce() -> std::io::Result<()>, link: &Path) -> bool {
        if create().is_err() {
            eprintln!("【跳过】当前环境不允许创建符号链接（通常需要开发者模式或管理员权限）");
            return false;
        }

        if fs::symlink_metadata(link)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return true;
        }

        eprintln!(
            "【跳过】当前环境创建不出真实符号链接：调用返回成功，产物却不是重分析点。\
             判定逻辑本身由 symlink_check_* 那几条用例覆盖。"
        );
        false
    }

    /// 造一个「指向授权目录之外」的文件符号链接。
    fn create_file_symlink(name: &str) -> Option<(TempTree, TempTree, PathBuf)> {
        let tree = TempTree::new(name);
        let outside = TempTree::new(&format!("{name}-outside"));
        outside.write("机密.txt", "不该被读到");

        let link = tree.root.join("链接.txt");

        #[cfg(windows)]
        let created = || std::os::windows::fs::symlink_file(outside.root.join("机密.txt"), &link);
        #[cfg(not(windows))]
        let created = || std::os::unix::fs::symlink(outside.root.join("机密.txt"), &link);

        if !symlink_or_skip(created, &link) {
            return None;
        }

        Some((tree, outside, link))
    }

    // ---- 授权目录校验 ----

    #[test]
    fn accepts_an_existing_directory() {
        let tree = TempTree::new("root-ok");
        let root = validate_authorized_root(&tree.root.to_string_lossy()).unwrap();
        assert!(root.is_dir());
    }

    #[test]
    fn rejects_empty_relative_and_non_absolute_paths() {
        assert!(validate_authorized_root("").is_err());
        assert!(validate_authorized_root("   ").is_err());
        assert!(validate_authorized_root("笔记").is_err());
    }

    #[test]
    fn rejects_a_path_that_does_not_exist() {
        let missing = std::env::temp_dir().join("ai-assistant-does-not-exist-xyz");
        assert!(validate_authorized_root(&missing.to_string_lossy()).is_err());
    }

    #[test]
    fn rejects_a_file_as_the_root() {
        let tree = TempTree::new("root-is-file");
        let file = tree.write("a.txt", "内容");
        let error = validate_authorized_root(&file.to_string_lossy()).unwrap_err();
        assert!(error.contains("不是一个目录"), "实际：{error}");
    }

    #[test]
    fn warns_when_the_whole_drive_is_authorized() {
        // 只提醒不阻断 —— 用户的机器他自己做主，但值得说一句
        assert!(broad_scope_warning(Path::new("C:\\")).is_some());
        assert!(broad_scope_warning(Path::new("D:\\")).is_some());
    }

    #[test]
    fn does_not_warn_for_a_normal_folder() {
        assert!(broad_scope_warning(Path::new("D:\\项目\\src")).is_none());
        assert!(broad_scope_warning(Path::new("D:\\笔记\\周会")).is_none());
    }

    #[test]
    fn warns_for_system_directories() {
        assert!(broad_scope_warning(Path::new("C:\\Windows")).is_some());
        assert!(broad_scope_warning(Path::new("C:\\Program Files")).is_some());
    }

    // ---- 路径逃逸防护（这一段是整个功能里最要紧的用例） ----

    #[test]
    fn resolves_a_normal_relative_path() {
        let tree = TempTree::new("resolve-ok");
        tree.write("a.txt", "内容");

        let resolved = resolve_within_root(&tree.root, "a.txt").unwrap();
        assert!(resolved.ends_with("a.txt"));
        assert!(resolved.starts_with(tree.root.canonicalize().unwrap()));
    }

    #[test]
    fn resolves_a_nested_relative_path() {
        let tree = TempTree::new("resolve-nested");
        tree.write("子目录/深/a.txt", "内容");

        let resolved = resolve_within_root(&tree.root, "子目录/深/a.txt").unwrap();
        assert!(resolved.ends_with("a.txt"));
    }

    #[test]
    fn rejects_an_absolute_path() {
        let tree = TempTree::new("reject-absolute");
        let outside = std::env::temp_dir().join("whatever.txt");

        let error = resolve_within_root(&tree.root, &outside.to_string_lossy()).unwrap_err();
        assert!(error.contains("相对路径"), "实际：{error}");
    }

    #[test]
    fn rejects_parent_directory_escapes() {
        let tree = TempTree::new("reject-parent");
        tree.write("里面/a.txt", "内容");

        // 这是最经典的一种：上跳一级再进别的目录
        assert!(resolve_within_root(&tree.root, "../外面.txt").is_err());
        assert!(resolve_within_root(&tree.root, "里面/../../外面.txt").is_err());
        assert!(resolve_within_root(&tree.root, "./../a.txt").is_err());
        assert!(resolve_within_root(&tree.root, "里面/../里面/a.txt").is_err());
    }

    #[test]
    fn rejects_windows_prefix_paths() {
        // `C:foo` 看着像相对路径，实际是「C 盘当前目录下的 foo」——
        // 只做 is_absolute 检查会漏掉它
        let tree = TempTree::new("reject-prefix");
        assert!(resolve_within_root(&tree.root, "C:a.txt").is_err());
        assert!(resolve_within_root(&tree.root, "\\\\server\\share\\a.txt").is_err());
    }

    #[test]
    fn rejects_dot_dot_even_when_it_would_stay_inside() {
        // 即使绕一圈还在目录内也拒绝：允许它就得依赖「规范化后恰好还在范围内」，
        // 那是把安全押在路径细节上。简单规则更难写错。
        let tree = TempTree::new("reject-dotdot-inside");
        tree.write("a/b.txt", "内容");

        assert!(resolve_within_root(&tree.root, "a/../a/b.txt").is_err());
    }

    #[test]
    fn rejects_an_empty_relative_path() {
        let tree = TempTree::new("reject-empty");
        assert!(resolve_within_root(&tree.root, "  ").is_err());
    }

    #[test]
    fn rejects_resolving_a_path_that_does_not_exist() {
        let tree = TempTree::new("reject-missing");
        assert!(resolve_within_root(&tree.root, "没有这个.txt").is_err());
    }

    #[test]
    fn refuses_a_symlink_pointing_outside_the_root() {
        // 三个值都要活着：outside 一被回收，链接就悬空了，测的就不是同一件事
        let Some((tree, _outside, _link)) = create_file_symlink("reject-symlink") else {
            return;
        };

        // 字符串层面它就是「授权目录里的一个文件」，只有拒绝跟随链接才挡得住。
        //
        // 注意这条用例的来历：最初这里断言的是「canonicalize 之后前缀比对会拒绝它」，
        // 实测发现 Windows 上 canonicalize 对最后一段符号链接并不解析到目标，
        // 于是它被判成了安全。现在的做法是路径上出现任何符号链接都直接拒。
        let error = resolve_within_root(&tree.root, "链接.txt").unwrap_err();
        assert!(error.contains("符号链接"), "实际：{error}");
    }

    #[test]
    fn refuses_a_symlinked_directory_on_the_way() {
        let tree = TempTree::new("reject-symlink-dir");
        let outside = TempTree::new("reject-symlink-dir-outside");
        outside.write("机密.txt", "不该被读到");

        let link = tree.root.join("跳板");

        #[cfg(windows)]
        let created = || std::os::windows::fs::symlink_dir(&outside.root, &link);
        #[cfg(not(windows))]
        let created = || std::os::unix::fs::symlink(&outside.root, &link);

        if !symlink_or_skip(created, &link) {
            return;
        }

        // 中间那一段是链接，绕过手法更隐蔽 —— 逐段检查才拦得住
        let error = resolve_within_root(&tree.root, "跳板/机密.txt").unwrap_err();
        assert!(error.contains("符号链接"), "实际：{error}");
    }

    // ---- 符号链接检查的逻辑本身 ----
    //
    // 上面两条端到端用例依赖「环境能创建真实符号链接」，而本机不行
    // （见 create_file_symlink 的说明）。下面几条把探测动作换掉，
    // 于是判定逻辑本身在任何环境里都能被测到。

    #[test]
    fn symlink_check_probes_every_component_including_the_last() {
        let probed = std::cell::RefCell::new(Vec::new());

        let result =
            ensure_no_symlink_with(Path::new("D:\\root"), Path::new("a/b/c.txt"), &|path| {
                probed.borrow_mut().push(path.to_path_buf());
                Ok(false)
            });

        assert!(result.is_ok());
        let probed = probed.into_inner();
        // 只查第一段、或者漏掉最后一段，都会让「目录里放个文件链接指向外面」得手
        assert_eq!(probed.len(), 3, "三段路径都要查：{probed:?}");
        assert!(probed[2].ends_with("c.txt"), "最后一段必须查：{probed:?}");
    }

    #[test]
    fn symlink_check_rejects_a_link_at_the_end() {
        let result =
            ensure_no_symlink_with(Path::new("D:\\root"), Path::new("a/b/c.txt"), &|path| {
                Ok(path.ends_with("c.txt"))
            });

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("符号链接"));
    }

    #[test]
    fn symlink_check_rejects_a_link_in_the_middle() {
        let result =
            ensure_no_symlink_with(Path::new("D:\\root"), Path::new("a/b/c.txt"), &|path| {
                Ok(path.ends_with("b"))
            });

        assert!(result.is_err(), "中间那一段是链接也要拒");
    }

    #[test]
    fn symlink_check_passes_a_clean_path() {
        let result = ensure_no_symlink_with(Path::new("D:\\root"), Path::new("a/b/c.txt"), &|_| {
            Ok(false)
        });
        assert!(result.is_ok());
    }

    #[test]
    fn symlink_check_propagates_probe_errors() {
        // 探测本身失败（比如权限不够）时要说出来，不能当成「不是链接」放过去
        let result = ensure_no_symlink_with(Path::new("D:\\root"), Path::new("a.txt"), &|_| {
            Err("读不到这个文件：拒绝访问".to_string())
        });

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("拒绝访问"));
    }

    // ---- 读取 ----

    #[test]
    fn reads_a_text_file() {
        let tree = TempTree::new("read-ok");
        tree.write("笔记.md", "# 标题\n正文");

        let content = read_text_file(&tree.root, "笔记.md").unwrap();
        assert_eq!(content.content, "# 标题\n正文");
        assert_eq!(content.relative_path, "笔记.md");
        assert!(!content.truncated);
        assert!(content.bytes > 0);
    }

    #[test]
    fn refuses_to_read_a_directory() {
        let tree = TempTree::new("read-dir");
        tree.mkdir("子目录");

        let error = read_text_file(&tree.root, "子目录").unwrap_err();
        assert!(error.contains("不是文件"), "实际：{error}");
    }

    #[test]
    fn refuses_binary_content_and_says_why() {
        let tree = TempTree::new("read-binary");
        // 一段不是合法 UTF-8 的字节
        fs::write(
            tree.root.join("图片.png"),
            [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe],
        )
        .unwrap();

        let error = read_text_file(&tree.root, "图片.png").unwrap_err();
        assert!(error.contains("UTF-8"), "实际：{error}");
    }

    #[test]
    fn truncates_large_files_instead_of_refusing() {
        let tree = TempTree::new("read-large");
        // 构造一个明显超过上限的文本
        let big = "一".repeat((MAX_READ_BYTES as usize / 3) + 5000);
        tree.write("大文件.txt", &big);

        let content = read_text_file(&tree.root, "大文件.txt").unwrap();

        assert!(content.truncated, "超过上限应当标记为已截断");
        assert!(content.bytes > MAX_READ_BYTES);
        // 实际读回来的内容必须被限制住，不能把整个文件塞进内存
        assert!(
            content.content.len() as u64 <= MAX_READ_BYTES + 4,
            "读回的字节数应当被限制在上限附近，实际 {}",
            content.content.len()
        );
    }

    #[test]
    fn reading_outside_the_root_is_refused() {
        let tree = TempTree::new("read-escape");
        let error = read_text_file(&tree.root, "../秘密.txt").unwrap_err();
        assert!(error.contains(".."), "实际：{error}");
    }

    // ---- 列目录 ----

    #[test]
    fn lists_directories_first_then_sorts_by_name() {
        let tree = TempTree::new("list-order");
        tree.write("b.txt", "b");
        tree.write("a.txt", "a");
        tree.mkdir("子目录");

        let entries = list_directory(&tree.root, "").unwrap();
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();

        assert_eq!(names, vec!["子目录", "a.txt", "b.txt"]);
        assert!(entries[0].is_directory);
        assert!(!entries[1].is_directory);
    }

    #[test]
    fn lists_a_subdirectory_with_relative_paths() {
        let tree = TempTree::new("list-sub");
        tree.write("子目录/a.txt", "内容");

        let entries = list_directory(&tree.root, "子目录").unwrap();
        assert_eq!(entries.len(), 1);
        // 返回的路径必须带上级，否则界面拿它去读会读错文件
        assert_eq!(entries[0].relative_path, "子目录/a.txt");
    }

    #[test]
    fn skips_hidden_entries() {
        let tree = TempTree::new("list-hidden");
        tree.write(".gitignore", "x");
        tree.write("正常.txt", "x");

        let entries = list_directory(&tree.root, "").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "正常.txt");
    }

    #[test]
    fn listing_outside_the_root_is_refused() {
        let tree = TempTree::new("list-escape");
        assert!(list_directory(&tree.root, "../").is_err());
    }

    #[test]
    fn listing_a_file_is_refused() {
        let tree = TempTree::new("list-file");
        tree.write("a.txt", "x");
        assert!(list_directory(&tree.root, "a.txt").is_err());
    }

    // ---- 读取审计 ----

    #[test]
    fn audit_keeps_the_newest_first() {
        let audit = ReadAudit::default();
        audit.record("第一个.txt", 1);
        audit.record("第二个.txt", 2);

        let recent = audit.recent();
        assert_eq!(recent[0].relative_path, "第二个.txt");
        assert_eq!(recent[1].relative_path, "第一个.txt");
    }

    #[test]
    fn audit_is_bounded() {
        let audit = ReadAudit::default();
        for index in 0..RECENT_READ_LIMIT + 5 {
            audit.record(&format!("文件{index}.txt"), 1);
        }

        // 有界才不会让内存随时间增长
        assert_eq!(audit.recent().len(), RECENT_READ_LIMIT);
    }

    #[test]
    fn audit_can_be_cleared() {
        let audit = ReadAudit::default();
        audit.record("a.txt", 1);
        audit.clear();
        assert!(audit.recent().is_empty());
    }
}

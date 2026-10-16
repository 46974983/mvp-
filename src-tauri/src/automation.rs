//! 键鼠模拟与可控自动化任务（阶段 D 最后一项）
//!
//! **协议与安全边界先写在 `docs/AUTOMATION_PROTOCOL.md`，这里照着实现。**
//! 顺序是有意的：协议一改，前端、Rust、测试三边都要跟着动，
//! 先把它写清楚再动手，比边写边定省事得多。
//!
//! ## 一句话说明这一项和前三项的区别
//!
//! 读文件、截屏、发附件都是**读** —— 最坏情况是「被看走了不该看的东西」。
//! 这一项是**写**：它会真的去动用户的鼠标和键盘，最坏情况是
//! 「用户在自己没预期的地方点出了后果」。所以这一项不靠「授权范围」兜底，
//! 靠的是**协议本身表达能力的上限**。
//!
//! ## 没有循环，是类型层面的
//!
//! `AutomationAction` 是一个扁平的枚举，没有条件、没有变量、没有递归。
//! **协议表达不出「重复执行」这件事**，所以不可能写出无限循环。
//! 这比「运行时检测到死循环再拦住」可靠 —— 后者要靠启发式判断，前者根本表达不出来。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use enigo::{Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// 上限（理由见 docs/AUTOMATION_PROTOCOL.md 第二节）
// ---------------------------------------------------------------------------

/// 单个任务的动作数上限。预览要能一眼看完 ——
/// 超过这个数，用户点「确认」时其实没在看。
pub const MAX_ACTIONS: usize = 20;

/// 单个 `wait` 的上限。再长的等待没有意义，而且会把「取消」的响应拖到不可接受。
pub const MAX_WAIT_MS: u64 = 10_000;

/// 整个任务的总时长上限。兜底用：超了就中止并说明，而不是让它在后台一直跑。
pub const MAX_TOTAL_MS: u64 = 60_000;

/// 一次 `type` 的文本长度上限
pub const MAX_TEXT_CHARS: usize = 2000;

/// 一个任务里 `type` 动作的个数上限
pub const MAX_TYPE_ACTIONS: usize = 5;

/// 每个非 `wait` 动作的估算耗时，用来算总时长预算
const STEP_OVERHEAD_MS: u64 = 50;

/// 等待切片。`wait` 被切成小片检查取消标志，长等待也能及时中断。
const CANCEL_POLL_MS: u64 = 50;

/// 获取自动化执行锁；失败表示已有任务正在操作系统输入设备。
///
/// 使用 try_lock 而不是等待，避免第二个调用看起来像「卡住」，
/// 也避免它在第一个任务结束后悄悄执行一份用户没有重新确认的动作列表。
pub fn try_acquire(lock: &Mutex<()>) -> Result<MutexGuard<'_, ()>, String> {
    lock.try_lock()
        .map_err(|_| "已有自动化任务正在执行，请等它结束或先停止当前任务。".to_string())
}

// ---------------------------------------------------------------------------
// 协议
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

impl MouseButton {
    pub fn label(self) -> &'static str {
        match self {
            MouseButton::Left => "左键",
            MouseButton::Right => "右键",
            MouseButton::Middle => "中键",
        }
    }

    fn to_enigo(self) -> Button {
        match self {
            MouseButton::Left => Button::Left,
            MouseButton::Right => Button::Right,
            MouseButton::Middle => Button::Middle,
        }
    }
}

/// 一个自动化动作。
///
/// **这是协议的全部。** 加新动作要同时改校验、上限、预览文案和测试 ——
/// 这份摩擦是故意的（见协议文档第三节）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AutomationAction {
    /// 把鼠标移到主屏坐标
    #[serde(rename_all = "camelCase")]
    Move { x: i32, y: i32 },
    /// 移到该点并点击
    #[serde(rename_all = "camelCase")]
    Click { x: i32, y: i32, button: MouseButton },
    /// 输入一段文字。**必须跟在 `click` 后面**，理由见 `validate`。
    #[serde(rename_all = "camelCase")]
    Type { text: String },
    /// 等待若干毫秒
    #[serde(rename_all = "camelCase")]
    Wait { ms: u64 },
}

/// 预览和执行报告里每步显示的文字。
///
/// 预览和报告用**同一份文案**是有意的：用户确认时看到的那句话，
/// 和事后回看日志时看到的那句话必须是同一句，否则「它到底做了什么」就有两种说法。
impl AutomationAction {
    pub fn describe(&self) -> String {
        match self {
            AutomationAction::Move { x, y } => format!("把鼠标移到 ({x}, {y})"),
            AutomationAction::Click { x, y, button } => {
                format!("在 ({x}, {y}) 点一下{}", button.label())
            }
            AutomationAction::Type { text } => {
                let trimmed = text.trim();
                let preview: String = trimmed.chars().take(20).collect();
                let suffix = if trimmed.chars().count() > 20 {
                    "…"
                } else {
                    ""
                };
                format!("输入「{preview}{suffix}」")
            }
            AutomationAction::Wait { ms } => format!("等 {ms} 毫秒"),
        }
    }

    /// 写进日志的那一行。
    ///
    /// 和 `describe()` 分开，只有一处差别：**`Type` 不记内容，只记字数。**
    /// 日志会落到磁盘上长期留着，而用户输入的文字可能包含任何东西 ——
    /// 界面上看一眼和执行之后在文件里留一份，是两件事。
    fn log_summary(&self) -> String {
        match self {
            AutomationAction::Type { text } => {
                format!("输入 {} 个字（内容不记入日志）", text.chars().count())
            }
            other => other.describe(),
        }
    }

    fn estimated_ms(&self) -> u64 {
        match self {
            AutomationAction::Wait { ms } => *ms,
            _ => STEP_OVERHEAD_MS,
        }
    }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/// 检查一个动作列表能不能执行。
///
/// `display` 是主屏尺寸 —— 坐标必须落在里面。用主屏是因为截屏也只截主屏，
/// 用户从截图上取点，两边的坐标系必须一致。
///
/// 返回的是**给用户看的一句话**，不是给开发者看的错误码。
pub fn validate(actions: &[AutomationAction], display: (u32, u32)) -> Result<(), String> {
    if actions.is_empty() {
        return Err("这个任务里没有任何动作。".to_string());
    }

    if actions.len() > MAX_ACTIONS {
        return Err(format!(
            "一个任务最多 {} 个动作，现在是 {} 个。动作太多的话，\
             确认的时候你会来不及看清它到底要做什么。",
            MAX_ACTIONS,
            actions.len()
        ));
    }

    let total_ms: u64 = actions.iter().map(AutomationAction::estimated_ms).sum();
    if total_ms > MAX_TOTAL_MS {
        return Err(format!(
            "这个任务预计要跑 {:.0} 秒，超过了 {} 秒的上限。请把等待时间改短，或者拆成几个任务。",
            total_ms as f64 / 1000.0,
            MAX_TOTAL_MS / 1000
        ));
    }

    let type_count = actions
        .iter()
        .filter(|action| matches!(action, AutomationAction::Type { .. }))
        .count();
    if type_count > MAX_TYPE_ACTIONS {
        return Err(format!(
            "一个任务最多 {} 个输入动作，现在是 {} 个。",
            MAX_TYPE_ACTIONS, type_count
        ));
    }

    let mut clicked = false;

    for (index, action) in actions.iter().enumerate() {
        let position = index + 1;

        match action {
            AutomationAction::Move { x, y } | AutomationAction::Click { x, y, .. } => {
                if *x < 0 || *y < 0 || *x >= display.0 as i32 || *y >= display.1 as i32 {
                    return Err(format!(
                        "第 {position} 个动作的坐标 ({x}, {y}) 超出了屏幕范围。\
                         当前主屏是 {}×{}，坐标要从左上角 (0, 0) 算起。",
                        display.0, display.1
                    ));
                }
                if matches!(action, AutomationAction::Click { .. }) {
                    clicked = true;
                }
            }

            AutomationAction::Type { text } => {
                if text.trim().is_empty() {
                    return Err(format!("第 {position} 个动作要输入的内容是空的。"));
                }
                if text.chars().count() > MAX_TEXT_CHARS {
                    return Err(format!(
                        "第 {position} 个动作要输入 {} 个字，超过了一次 {} 字的上限。",
                        text.chars().count(),
                        MAX_TEXT_CHARS
                    ));
                }

                // 整个协议里最要紧的一条规则。
                // 文字走键盘事件，会打到当前有焦点的窗口上；如果允许凭空输入，
                // 焦点在哪个窗口完全取决于用户在确认和执行之间有没有切窗口 ——
                // 而这件事在预览里是看不见的（预览里根本没有「窗口」这个概念）。
                if !clicked {
                    return Err(
                        "输入动作之前必须先有一个点击动作。文字会打到当前有焦点的窗口上，\
                         而这件事你在预览里看不到 —— 所以协议要求先点一下目标位置把焦点点出来。"
                            .to_string(),
                    );
                }
            }

            AutomationAction::Wait { ms } => {
                if *ms > MAX_WAIT_MS {
                    return Err(format!(
                        "第 {position} 个动作要等 {ms} 毫秒，超过了单步 {} 毫秒的上限。",
                        MAX_WAIT_MS
                    ));
                }
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/// 一步的执行结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStep {
    /// 从 0 开始
    pub index: usize,
    /// 人话描述，和预览里看到的是同一句
    pub action: String,
    pub ok: bool,
    /// 失败原因；成功时为空
    pub detail: String,
}

/// 一次执行的报告
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationReport {
    pub steps: Vec<AutomationStep>,
    /// 是否被用户中断（区别于「跑完了」和「失败了」）
    pub stopped: bool,
    /// 是否因为超过总时长上限而中止
    pub timed_out: bool,
    pub elapsed_ms: u64,
}

/// 中断等待。返回 false 表示被取消了。
fn sleep_interruptible(ms: u64, cancel: &AtomicBool) -> bool {
    let deadline = Instant::now() + Duration::from_millis(ms);

    loop {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        std::thread::sleep(remaining.min(Duration::from_millis(CANCEL_POLL_MS)));
    }
}

/// 执行一个动作列表。
///
/// 停下来有三种原因，报告里分得清清楚楚：
///   - 跑完了（`stopped` 和 `timed_out` 都是 false）
///   - 用户点了停止（`stopped`）
///   - 超过总时长（`timed_out`）
///
/// **某一步失败就停下，不继续后面的动作** —— 后面那些动作的坐标很可能
/// 基于「前一步成功了」这个假设，硬着头皮跑下去更危险。
pub fn run(actions: &[AutomationAction], cancel: &AtomicBool) -> AppResult<AutomationReport> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|error| AppError::Invalid(format!("初始化键鼠模拟失败：{error}")))?;

    let started = Instant::now();
    let mut steps: Vec<AutomationStep> = Vec::with_capacity(actions.len());
    let mut stopped = false;
    let mut timed_out = false;

    for (index, action) in actions.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            stopped = true;
            break;
        }

        // 总时长兜底。检查放在每一步之前，所以最多超出一个单步的时间。
        if started.elapsed().as_millis() as u64 > MAX_TOTAL_MS {
            timed_out = true;
            break;
        }

        log::info!("自动化第 {} 步：{}", index + 1, action.log_summary());

        match perform(&mut enigo, action, cancel) {
            Ok(true) => steps.push(AutomationStep {
                index,
                action: action.describe(),
                ok: true,
                detail: String::new(),
            }),

            // 等待中途被取消：这一步不算成功，也不算失败
            Ok(false) => {
                stopped = true;
                break;
            }

            Err(error) => {
                log::warn!("自动化第 {} 步失败：{error}", index + 1);
                steps.push(AutomationStep {
                    index,
                    action: action.describe(),
                    ok: false,
                    detail: error.clone(),
                });
                break;
            }
        }
    }

    let elapsed_ms = started.elapsed().as_millis() as u64;
    log::info!(
        "自动化任务结束（跑了 {} 步，{elapsed_ms} 毫秒，中断：{stopped}，超时：{timed_out}）",
        steps.len()
    );

    Ok(AutomationReport {
        steps,
        stopped,
        timed_out,
        elapsed_ms,
    })
}

/// 执行单个动作。返回 false 表示被取消了。
fn perform(
    enigo: &mut Enigo,
    action: &AutomationAction,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    let describe = || action.describe();

    match action {
        AutomationAction::Move { x, y } => {
            enigo
                .move_mouse(*x, *y, Coordinate::Abs)
                .map_err(|error| format!("{}失败：{error}", describe()))?;
            Ok(true)
        }

        AutomationAction::Click { x, y, button } => {
            enigo
                .move_mouse(*x, *y, Coordinate::Abs)
                .map_err(|error| format!("{}失败：{error}", describe()))?;
            enigo
                .button(button.to_enigo(), Direction::Click)
                .map_err(|error| format!("{}失败：{error}", describe()))?;
            Ok(true)
        }

        AutomationAction::Type { text } => {
            enigo
                .text(text)
                .map_err(|error| format!("{}失败：{error}", describe()))?;
            Ok(true)
        }

        AutomationAction::Wait { ms } => Ok(sleep_interruptible(*ms, cancel)),
    }
}

/// 主屏尺寸，用来校验坐标。
///
/// 用 xcap 而不是 enigo 的 `main_display()`：截屏用的就是 xcap，
/// 用户从截图上取的坐标和这里的坐标系必须是同一套。
pub fn primary_display() -> Result<(u32, u32), String> {
    let monitors = xcap::Monitor::all().map_err(|error| format!("枚举屏幕失败：{error}"))?;
    let monitor = monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or_else(|| "没有检测到任何屏幕。".to_string())?;

    let width = monitor
        .width()
        .map_err(|error| format!("读不到屏幕宽度：{error}"))?;
    let height = monitor
        .height()
        .map_err(|error| format!("读不到屏幕高度：{error}"))?;

    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const DISPLAY: (u32, u32) = (1920, 1080);

    fn move_to(x: i32, y: i32) -> AutomationAction {
        AutomationAction::Move { x, y }
    }

    fn click_at(x: i32, y: i32) -> AutomationAction {
        AutomationAction::Click {
            x,
            y,
            button: MouseButton::Left,
        }
    }

    fn type_text(text: &str) -> AutomationAction {
        AutomationAction::Type {
            text: text.to_string(),
        }
    }

    fn wait(ms: u64) -> AutomationAction {
        AutomationAction::Wait { ms }
    }

    // ---- 校验：能过的 ----

    #[test]
    fn accepts_a_normal_task() {
        let actions = vec![
            move_to(100, 200),
            click_at(100, 200),
            wait(300),
            type_text("你好"),
        ];
        assert!(validate(&actions, DISPLAY).is_ok());
    }

    // ---- 校验：上限 ----

    #[test]
    fn rejects_an_empty_task() {
        assert!(validate(&[], DISPLAY).unwrap_err().contains("没有任何动作"));
    }

    #[test]
    fn rejects_too_many_actions() {
        let actions: Vec<_> = (0..MAX_ACTIONS + 1).map(|x| move_to(x as i32, 0)).collect();
        let error = validate(&actions, DISPLAY).unwrap_err();

        assert!(
            error.contains(&MAX_ACTIONS.to_string()),
            "要说清上限是多少：{error}"
        );
    }

    #[test]
    fn rejects_a_single_wait_that_is_too_long() {
        let error = validate(&[wait(MAX_WAIT_MS + 1)], DISPLAY).unwrap_err();
        assert!(error.contains("上限"), "{error}");
    }

    #[test]
    fn rejects_a_task_that_would_run_too_long() {
        // 每一步都不超单步上限，加起来超了总时长 —— 这正是总时长上限存在的理由
        let actions: Vec<_> = (0..8).map(|_| wait(MAX_WAIT_MS)).collect();
        let error = validate(&actions, DISPLAY).unwrap_err();

        assert!(error.contains("秒"), "要说清是时长问题：{error}");
    }

    #[test]
    fn rejects_too_many_type_actions() {
        let mut actions: Vec<_> = (0..=MAX_TYPE_ACTIONS).map(|_| click_at(10, 10)).collect();
        actions.extend((0..=MAX_TYPE_ACTIONS).map(|_| type_text("x")));

        let error = validate(&actions, DISPLAY).unwrap_err();
        assert!(error.contains("输入动作"), "{error}");
    }

    #[test]
    fn accepts_a_wait_exactly_at_the_limit() {
        // 边界：等于上限应当通过，「超过」才拒
        assert!(validate(&[wait(MAX_WAIT_MS)], DISPLAY).is_ok());
    }

    // ---- 校验：坐标 ----

    #[test]
    fn rejects_coordinates_off_the_screen() {
        assert!(
            validate(&[move_to(1920, 100)], DISPLAY).is_err(),
            "右边界外一格"
        );
        assert!(
            validate(&[move_to(100, 1080)], DISPLAY).is_err(),
            "下边界外一格"
        );
        assert!(validate(&[move_to(-1, 0)], DISPLAY).is_err(), "负坐标");
        assert!(validate(&[click_at(5000, 5000)], DISPLAY).is_err());
    }

    #[test]
    fn accepts_the_bottom_right_pixel() {
        // 坐标是从 0 算起的，所以最后一个像素是 (宽-1, 高-1)
        assert!(validate(&[move_to(1919, 1079)], DISPLAY).is_ok());
    }

    #[test]
    fn the_coordinate_error_names_the_position_and_the_screen() {
        let error = validate(&[move_to(10, 10), move_to(9999, 10)], DISPLAY).unwrap_err();

        assert!(error.contains("第 2 个动作"), "要指出是哪一个动作：{error}");
        assert!(error.contains("1920"), "要说清屏幕多大：{error}");
    }

    // ---- 校验：输入动作的前置条件（最要紧的一条）----

    #[test]
    fn rejects_typing_without_a_click_first() {
        let error = validate(&[type_text("你好")], DISPLAY).unwrap_err();

        // 这条规则的意义：文字会打到当前有焦点的窗口上，
        // 而那件事在预览里看不见 —— 所以必须先把焦点点出来
        assert!(error.contains("点击"), "要说清需要先做什么：{error}");
        assert!(error.contains("焦点"), "要说清为什么：{error}");
    }

    #[test]
    fn allows_typing_after_a_click() {
        assert!(validate(&[click_at(10, 10), type_text("你好")], DISPLAY).is_ok());
    }

    #[test]
    fn allows_a_wait_between_the_click_and_the_typing() {
        // 「点一下、等一下界面出来、再输入」是完全合理的用法，
        // 所以规则是「之前出现过点击」，而不是「必须紧挨着」
        assert!(validate(&[click_at(10, 10), wait(500), type_text("你好")], DISPLAY).is_ok());
    }

    #[test]
    fn rejects_empty_text() {
        let error = validate(&[click_at(10, 10), type_text("   ")], DISPLAY).unwrap_err();
        assert!(error.contains("空"), "{error}");
    }

    #[test]
    fn rejects_text_that_is_too_long() {
        let long = "字".repeat(MAX_TEXT_CHARS + 1);
        let error = validate(&[click_at(10, 10), type_text(&long)], DISPLAY).unwrap_err();
        assert!(error.contains("上限"), "{error}");
    }

    #[test]
    fn counts_characters_not_bytes() {
        // 2000 个汉字是 6000 字节。按字节算的话中文用户会莫名其妙被拒
        let text = "字".repeat(MAX_TEXT_CHARS);
        assert!(validate(&[click_at(10, 10), type_text(&text)], DISPLAY).is_ok());
    }

    // ---- 文案 ----

    #[test]
    fn descriptions_read_like_sentences() {
        assert_eq!(move_to(640, 360).describe(), "把鼠标移到 (640, 360)");
        assert_eq!(click_at(640, 360).describe(), "在 (640, 360) 点一下左键");
        assert_eq!(wait(300).describe(), "等 300 毫秒");
        assert_eq!(type_text("你好").describe(), "输入「你好」");
    }

    #[test]
    fn long_text_is_truncated_in_the_preview() {
        let long = "字".repeat(50);
        let described = type_text(&long).describe();

        assert!(described.contains('…'), "预览要截断：{described}");
        assert!(described.chars().count() < 30);
    }

    #[test]
    fn the_log_line_never_contains_typed_text() {
        // 日志会落到磁盘上长期留着，而用户输入的文字可能包含任何东西 ——
        // 界面上看一眼和执行之后在文件里留一份，是两件事
        let secret = "我的密码是 hunter2";
        let action = type_text(secret);
        let logged = action.log_summary();

        assert!(
            !logged.contains("hunter2"),
            "日志里不能有输入内容：{logged}"
        );
        assert!(
            !logged.contains("密码"),
            "也不该带上文本的任何片段：{logged}"
        );
        assert!(
            logged.contains(&secret.chars().count().to_string()),
            "但要说清输了多少个字，否则日志看不出这一步做了什么：{logged}"
        );
    }

    #[test]
    fn the_log_line_matches_the_preview_for_other_actions() {
        // 除了 Type，其他动作的日志和预览是同一句 —— 事后再看才认得出做了什么
        assert_eq!(move_to(1, 2).log_summary(), move_to(1, 2).describe());
    }

    // ---- 中断 ----

    #[test]
    fn a_wait_can_be_interrupted() {
        let cancel = AtomicBool::new(true);
        let started = Instant::now();

        assert!(!sleep_interruptible(5_000, &cancel));
        assert!(
            started.elapsed().as_millis() < 500,
            "取消之后不该还等满 5 秒"
        );
    }

    #[test]
    fn a_wait_finishes_when_not_cancelled() {
        let cancel = AtomicBool::new(false);
        assert!(sleep_interruptible(60, &cancel));
    }

    #[test]
    fn a_second_automation_run_is_rejected_while_the_lock_is_held() {
        let lock = Mutex::new(());
        let _first = try_acquire(&lock).expect("第一个任务应能拿到锁");
        let second = try_acquire(&lock);
        assert_eq!(
            second.unwrap_err(),
            "已有自动化任务正在执行，请等它结束或先停止当前任务。"
        );
    }
}

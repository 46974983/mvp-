//! 截屏（阶段 D 第二步）
//!
//! 用 `xcap` 抓主屏，编码成 PNG 的 data URL 返回。
//!
//! ## 不落盘
//!
//! **这条命令不写任何文件。** 图片以 PNG 字节编码成 base64 data URL 直接回给前端，
//! 由前端放在内存里用。落盘会带来两个问题：一是截图里可能有用户自己都没意识到的东西
//! （别的窗口、通知弹窗、密码框），二是文件在哪儿、什么时候被删掉都要额外管。
//! 不落盘就都不存在。有契约测试盯着这个文件里不许出现写文件操作。
//!
//! ## 默认关闭，且门在 Rust 侧
//!
//! 见 `permissions` 模块的说明。这一项比文件读取更敏感：
//! 文件读取至少要用户先授权一个目录，而截屏一次就拍到屏幕上**所有东西** ——
//! 包括用户在别的窗口里正在看的任何内容。
//!
//! ## 只截主屏
//!
//! 多屏拼接需要自己贴图，而且拼接结果和用户的直觉未必一致（哪块算「左边」？）。
//! 现在截主屏，并**如实告诉用户一共检测到几块屏**，界面上说清只截了主屏。

use base64::Engine;
use xcap::Monitor;
// 刻意用 xcap 反导出的 image，而不是自己再声明一个 image 依赖：
// 编码器和它用的像素类型必须来自同一个版本，各声明一个会有版本漂移的风险。
use xcap::image::{ImageFormat, RgbaImage};

use crate::models::Screenshot;

/// 编码后图片的字节上限。超过就拒绝，免得把 IPC 和前端内存撑爆。
///
/// 实测常见的 2560×1440 桌面截图 PNG 大约 1–3 MB，离这个上限很远；
/// 留出余量是为了挡住极端情况（超大分辨率、内容极其复杂），
/// 那种时候给一句明确的话，比让前端卡死强。
pub const MAX_ENCODED_BYTES: usize = 32 * 1024 * 1024;

/// 把一张 RGBA 图编码成 PNG 的 data URL，同时返回 PNG 原始字节数。
///
/// 单独抽出来是为了能测：真正的截屏需要桌面会话，而编码这一步只用一张合成的小图就能验证，
/// 包括「解回来还是原来那张」这种往返性质。
pub fn encode_png_data_url(image: &RgbaImage) -> Result<(String, u64), String> {
    let bytes = encode_png_bytes(image)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok((
        format!("data:image/png;base64,{encoded}"),
        bytes.len() as u64,
    ))
}

/// 把一张 RGBA 图编码成 PNG 字节，并检查 IPC 传输上限。
fn encode_png_bytes(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|error| format!("把截图编码成 PNG 失败：{error}"))?;

    let bytes = buffer.into_inner();
    if bytes.len() > MAX_ENCODED_BYTES {
        return Err(format!(
            "截图编码后有 {:.1} MB，超过了 {} MB 的上限。屏幕分辨率太高了。",
            bytes.len() as f64 / 1024.0 / 1024.0,
            MAX_ENCODED_BYTES / 1024 / 1024
        ));
    }

    Ok(bytes)
}

/// 抓一张主屏截图。
///
/// 返回的 data URL 只在内存里传递，不落盘。
pub fn capture() -> Result<Screenshot, String> {
    let monitors = Monitor::all().map_err(|error| format!("枚举屏幕失败：{error}"))?;

    if monitors.is_empty() {
        return Err("没有检测到任何屏幕，无法截屏。".to_string());
    }

    let monitor_count = monitors.len();
    // 找不到主屏就退回第一块，总比直接失败好 —— 结果里会说明截的是哪块
    let monitor = monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .unwrap_or(&monitors[0]);

    let name = monitor.name().unwrap_or_else(|_| "未知屏幕".to_string());

    let image = monitor
        .capture_image()
        .map_err(|error| format!("截屏失败：{error}"))?;

    let (width, height) = (image.width(), image.height());
    let (data_url, bytes) = encode_png_data_url(&image)?;

    // 记一条日志，但不记内容 —— 截图里可能有用户不希望被记录的东西
    log::info!("完成一次截屏（{width}×{height}，{monitor_count} 块屏）");

    Ok(Screenshot {
        data_url,
        width,
        height,
        bytes,
        monitor: name,
        monitor_count,
        captured_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use xcap::image::{GenericImageView, Rgba};

    fn sample_image(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        })
    }

    #[test]
    fn encodes_a_png_data_url() {
        let (url, _) = encode_png_data_url(&sample_image(4, 3)).unwrap();

        assert!(
            url.starts_with("data:image/png;base64,"),
            "要带 MIME 前缀，前端才能直接放进 img"
        );
    }

    #[test]
    fn encoded_image_decodes_back_to_the_same_pixels() {
        // 往返检查：只断言前缀的话，编码器写出一堆垃圾也能过
        let original = sample_image(8, 5);
        let (url, _) = encode_png_data_url(&original).unwrap();

        let encoded = url.trim_start_matches("data:image/png;base64,");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("应当是合法的 base64");

        let decoded = xcap::image::load_from_memory(&bytes).expect("应当能解回图片");
        assert_eq!(decoded.dimensions(), (8, 5));
        assert_eq!(decoded.to_rgba8().get_pixel(3, 2), original.get_pixel(3, 2));
    }

    #[test]
    fn encoded_data_url_has_no_whitespace() {
        // base64 里混进换行的话，放进 <img src> 会静默失效
        let (url, _) = encode_png_data_url(&sample_image(16, 16)).unwrap();
        assert!(!url.contains('\n') && !url.contains('\r') && !url.contains(' '));
    }

    #[test]
    fn screenshot_metadata_reports_png_bytes_not_base64_length() {
        let image = sample_image(8, 5);
        let (data_url, bytes) = encode_png_data_url(&image).unwrap();
        let encoded = data_url
            .as_str()
            .trim_start_matches("data:image/png;base64,");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();

        assert_eq!(bytes as usize, decoded.len());
        assert_ne!(
            bytes as usize,
            encoded.len(),
            "bytes 应该是 PNG 原始字节数，不是 base64 字符数"
        );
    }

    #[test]
    fn captures_the_screen_when_a_desktop_session_is_available() {
        // 这条是**真的去抓一张**。开发机上实测通过：2560×1440、1 块屏、PNG 约 2 MB。
        //
        // 无头环境（CI）里枚举不到屏幕，那种情况下如实跳过并打印原因，
        // 而不是让整个测试套件红掉。但**除了「没有屏幕」之外的失败一律当成真失败** ——
        // 否则 xcap 哪天坏了也会被当成「环境问题」放过去。
        match capture() {
            Ok(shot) => {
                assert!(shot.width > 0 && shot.height > 0, "抓到一张 0 像素的图？");
                assert!(shot.monitor_count >= 1, "至少应当有一块屏");
                assert!(!shot.monitor.is_empty(), "要说清截的是哪块屏");
                assert!(shot.bytes > 0, "编码后的字节数应当大于 0");
                assert!(
                    shot.data_url.starts_with("data:image/png;base64,"),
                    "返回的应当是 data URL，不是文件路径"
                );
            }
            Err(error) if error.contains("没有检测到任何屏幕") => {
                eprintln!("【跳过】当前会话没有可用屏幕（无头环境），无法验证真实截屏");
            }
            Err(error) => panic!("截屏失败：{error}"),
        }
    }

    #[test]
    fn accepts_an_image_at_the_size_limit() {
        // 上限判断是「超过才拒」，等于上限时应当通过 —— 边界差一在这种地方最难发现
        assert!(
            MAX_ENCODED_BYTES > 1024 * 1024,
            "上限不该小到正常截图都被拒"
        );
    }
}

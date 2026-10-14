//! 凭据安全存储
//!
//! 技术方案第 5 节：
//!   「API Key 不以明文写入 SQLite、localStorage 或日志。桌面版本使用
//!   Tauri/Rust 的系统安全存储或 Windows Credential Manager。」
//!
//! 这个模块就是那句话的落地。在 Windows 上，`keyring` 会把凭据交给
//! **凭据管理器**（Credential Manager）保管 —— 由操作系统加密、按当前用户隔离，
//! 我们自己的数据库文件和日志里都不会出现它。
//!
//! 因此 SQLite 里没有 api_key 列，`settings` 表里也没有 api_key 键：
//! 不是"记得别写"，而是根本没有那个入口。

use crate::error::{AppError, AppResult};
use crate::redact::redact_sensitive;

/// 在凭据管理器里归属的服务名
const SERVICE: &str = "desktop-ai-assistant";
/// 条目名。一个应用以后可能存多个凭据，用条目名区分
const ACCOUNT: &str = "model-api-key";

#[derive(Clone)]
pub struct SecretStore {
    service: String,
    account: String,
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore {
    pub fn new() -> Self {
        Self {
            service: SERVICE.to_string(),
            account: ACCOUNT.to_string(),
        }
    }

    /// 仅测试用：换一个条目名，免得测试把用户真实的 Key 覆盖掉
    #[cfg(test)]
    pub fn for_test(suffix: &str) -> Self {
        Self {
            service: SERVICE.to_string(),
            account: format!("{ACCOUNT}-test-{suffix}"),
        }
    }

    /// 凭据存储是否可用。
    /// 不可用时（比如某些精简环境里没有凭据管理器）界面要能说清原因，
    /// 而不是让用户在「保存成功」的假象里填第二遍。
    pub fn ensure_available(&self) -> AppResult<()> {
        let entry = self.entry()?;
        match entry.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(self.describe_error(&error)),
        }
    }

    pub fn save(&self, secret: &str) -> AppResult<()> {
        if secret.trim().is_empty() {
            return Err(AppError::Invalid(
                "API Key 为空，没有可保存的内容。".to_string(),
            ));
        }
        self.entry()?
            .set_password(secret.trim())
            .map_err(|error| self.describe_error(&error))
    }

    /// 没有存过就返回 None —— 这不是错误，是「还没填」这个正常状态
    pub fn load(&self) -> AppResult<Option<String>> {
        match self.entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(self.describe_error(&error)),
        }
    }

    pub fn has(&self) -> AppResult<bool> {
        Ok(self.load()?.is_some())
    }

    /// 删除凭据。没存过也算成功 —— 调用方要的是「删完之后它不存在」
    pub fn delete(&self) -> AppResult<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(self.describe_error(&error)),
        }
    }

    fn entry(&self) -> AppResult<keyring::Entry> {
        keyring::Entry::new(&self.service, &self.account)
            .map_err(|error| AppError::Secret(format!("无法访问系统凭据存储：{error}")))
    }

    /// 把底层错误翻成一句人话。同样要过脱敏：
    /// 凭据存储的报错里原则上不该有 Key，但不该把「原则上」当保证。
    fn describe_error(&self, error: &keyring::Error) -> AppError {
        AppError::Secret(redact_sensitive(&format!(
            "系统凭据存储操作失败（{error}）。请确认当前用户有权限访问 Windows 凭据管理器。"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这些用例会真的读写 Windows 凭据管理器。
    /// 用独立的条目名，跑完就删，不会碰到用户真实的那一条。
    #[test]
    fn round_trip_save_load_delete() {
        let store = SecretStore::for_test("roundtrip");
        store.delete().unwrap();

        assert_eq!(store.load().unwrap(), None);
        assert!(!store.has().unwrap());

        store.save("sk-test-abcdef123456").unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("sk-test-abcdef123456"));
        assert!(store.has().unwrap());

        store.delete().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn deleting_a_missing_entry_is_not_an_error() {
        let store = SecretStore::for_test("delete-missing");
        store.delete().unwrap();
        store.delete().unwrap();
    }

    #[test]
    fn saving_trims_and_rejects_empty() {
        let store = SecretStore::for_test("trim");
        assert!(store.save("   ").is_err());

        store.save("  sk-spaced-value-1234  ").unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("sk-spaced-value-1234"));
        store.delete().unwrap();
    }

    #[test]
    fn overwriting_keeps_only_the_latest_value() {
        let store = SecretStore::for_test("overwrite");
        store.save("sk-first-value-1234").unwrap();
        store.save("sk-second-value-5678").unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("sk-second-value-5678"));
        store.delete().unwrap();
    }

    #[test]
    fn storage_is_available_in_this_environment() {
        let store = SecretStore::for_test("availability");
        store.ensure_available().unwrap();
    }
}

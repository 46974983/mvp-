-- ===========================================================================
-- 0001_init —— 初始表结构
-- ---------------------------------------------------------------------------
-- 对应技术方案第 5 节的三张表：
--   conversations：会话标题、创建时间、更新时间、归档状态
--   messages      ：会话 ID、角色、内容、状态、创建时间
--   settings      ：非敏感应用设置和人格配置（键值对）
--
-- 刻意没有 api_key 相关的列或键：凭据不在这张库里，也不在任何一张表里。
-- 它由 Rust 侧交给系统凭据存储（Windows 凭据管理器）。
-- ===========================================================================

CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT    PRIMARY KEY,
    title      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    -- SQLite 没有布尔类型，用 0/1 表达
    archived   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT    PRIMARY KEY,
    conversation_id TEXT    NOT NULL
                            REFERENCES conversations (id) ON DELETE CASCADE,
    role            TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT    NOT NULL,
    status          TEXT    NOT NULL
                            CHECK (status IN ('streaming', 'complete', 'aborted', 'error')),
    created_at      INTEGER NOT NULL
);

-- 非敏感设置：键值对。用键值而不是固定列，是因为设置项会随版本增删，
-- 每加一项就改一次表结构不划算。
-- 这里**只放非敏感项**：人格配置、模型地址、模型名。
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 会话列表按 updated_at 倒序、消息按 created_at 正序，都是常态查询，先建索引
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
    ON conversations (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages (conversation_id, created_at);

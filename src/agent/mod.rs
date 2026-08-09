//! Agent 公共模块（引擎无关）：状态数据模型、CLI 识别、屏幕规则检测、进程树扫描。
//!
//! 会话引擎特定的信道（如复用器 option 注入、HTTP 回调）不在本模块，
//! 见 `src/engine/` 下各引擎实现。

pub mod cli;
pub mod detect;
pub mod process;
pub mod state;

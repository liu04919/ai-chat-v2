# @ai-chat/core

这个 package 保存不依赖 Next.js、数据库、队列和 AI SDK 的领域规则。

`core` 与 `contracts` 的职责不同：`core` 描述系统内部业务语义，`contracts` 描述跨进程传输格式。两边可能出现相同的字面值，例如 `chat | image`，但不能让 wire DTO 反向成为领域实体。

当前只实现已经拍板且可以独立验证的规则：Conversation mode 创建后不可变，以及 Generation active/terminal 状态判断。

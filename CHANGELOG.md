# Changelog

## 0.2.0

- Сохранение bot tokens из MCP/stdin в зашифрованной локальной базе, совместимость с env-профилями и проверяемая ротация.
- Названия/описания ботов и аудитории чатов, регистрация по публичной ссылке или @username со стабильным числовым routing.
- Политики all/selected/deny, read/write/manage, отдельные bindings по Git identity или точной директории.
- Runtime enforcement для публикаций, архива, статистики, audit и replay; редактирование, удаление, revision conflicts и default deny.
- Контекст MCP roots/cwd, блокирование неоднозначного контекста; 27 инструментов и 39 локальных тестов.
- Живая проверка через MCP: регистрация/инспекция, текст, replay/conflict, правка, pin/unpin, delete, collector, архив/статистика и default deny другой директории. Временные сообщения удалены.
- Отдельный `test:live` с явными bot/target аргументами и отчётом без credentials.

## 0.1.0

- Общий локальный Telegram runtime с несколькими ботами и чатами, без hardcode credentials и адресатов.
- CLI, 15 MCP-инструментов, сборщик, архив, статистика и audit с request_id.
- Skill, манифесты Codex/Claude и генератор MCP-конфигурации OpenCode/Codex/Claude.
- Поведенческие и MCP-проверки, архитектура, этапы и границы приёмки.

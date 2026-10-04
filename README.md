# Teleprompt

Общий локальный рантайм для управления Telegram от лица ботов из OpenCode, Codex и Claude Code. Можно работать над любым проектом или вести обычный разговор с агентом и попросить: «Опубликуй это в community», «Отредактируй сообщение 123», «Посмотри последние сообщения», «Проанализируй активность за неделю».

Модель работает в агенте. Teleprompt предоставляет MCP-инструменты и исполняет Telegram-операции; собственный LLM-провайдер ему не нужен. Боты и чаты задаются профилями. Общая база находится в каталоге пользователя, независимо от текущего репозитория.

Версия 0.2 добавляет сохранённые credentials, описания и политики доступа по проекту/директории. На реальном тестовом канале через MCP проверены публикация, повтор запроса, правка, закрепление/открепление, удаление, архив и блокировка чужой директории. Нативная загрузка ещё требует приёмки. [Архитектура](docs/ARCHITECTURE.md), [политики](docs/ACCESS_POLICIES.md), [этапы](docs/ROADMAP.md), [проверки](docs/VALIDATION.md).

## Возможности

- Несколько ботов и чатов; каждый alias чата связывает конкретный `bot + chat_id`.
- Текст, редактирование, фото и документы по HTTPS URL / `file_id`, темы группы, удаление и пины.
- Текущие сведения о чате, число участников и права бота.
- Сбор обновлений, поиск и просмотр локального архива, статистика сообщений и авторов с границами покрытия.
- SQLite, отдельный `watch`, журнал операций, защита от автоматических дублей и одновременного сбора одним ботом.
- 27 MCP-инструментов, CLI, skill, манифесты Codex / Claude Code и генератор конфигурации для трёх клиентов.
- Токены из чата или прочитанного агентом файла сохраняются зашифрованно в локальной базе; переменные среды остаются совместимым вариантом.
- Описания ботов и аудитории чатов, редактируемые политики и привязки: все пары, выбранные пары или запрет.

Bot API не предоставляет произвольную старую историю. Архив состоит из доступных боту обновлений и публикаций через Teleprompt. Неполный архив нельзя выдавать за полную статистику группы; видимость зависит от прав и privacy mode. Необработанные обновления хранятся в Telegram до 24 часов. [Telegram Bot API](https://core.telegram.org/bots/api), [Bots FAQ](https://core.telegram.org/bots/faq).

## Сборка и установка

Нужен Node.js ≥22.13. Встроенный `node:sqlite` на этой минимальной версии имеет экспериментальный статус. [Node.js SQLite](https://nodejs.org/api/sqlite.html).

```powershell
npm ci
npm run build
node ./dist/cli.js init
npm pack
npm install --global ./lotargo-teleprompt-0.2.0.tgz
teleprompt --help
```

Сборка включает зависимости в `dist/cli.js`: копии плагина достаточно Node.js, node_modules в кеше не требуется. Разработка и тесты сами не устанавливают пакет глобально и не меняют настройки клиентов.

## Боты и чаты

Пришли токен агенту в чате либо попроси его прочитать файл обычным инструментом чтения. Агент вызывает `telegram_register_bot` с токеном, названием и описанием. Токен проверяется через getMe и сохраняется зашифрованно в общей SQLite; отдельного импорта файлов нет. Для ручного CLI значение передаётся через stdin. Файл credentials.key находится рядом с базой вне репозитория и нужен для восстановления сохранённых credentials.

`init` показывает контекст и не выдаёт разрешения автоматически. Для проекта управления можно явно разрешить все профили и администрирование:

```powershell
teleprompt init --allow-all --manage --policy development
Get-Content -LiteralPath 'C:/private/bot-token.txt' | teleprompt bots add --alias news --token-stdin --description 'Публикации проекта'
# Совместимый вариант с переменной среды:
teleprompt bots add --alias news --token-env TELEGRAM_NEWS_TOKEN
teleprompt bots add --alias work --token-env TELEGRAM_WORK_TOKEN
teleprompt chats add --alias community --bot news --chat-id @public_channel --write --description 'Публичные новости; без внутренних данных'
teleprompt chats add --alias workroom --bot work --chat-id -1009876543210
teleprompt chats access --alias workroom --write
teleprompt inspect --target community
```

Ссылки/ID и имена выше примерные. Один бот не добавляется повторно под другим alias: используй update для его описания или токена. Chat поддерживает числовой ID, @username и публичную t.me-ссылку; хранится стабильный числовой ID. Название группы используется для выбора по каталогу, оно само не заменяет Telegram ID. Без --write профиль запрещает запись. Политика workspace, локальное write-разрешение и Telegram-права — независимые условия. [Telegram Bot API](https://core.telegram.org/bots/api).

Без Git привязка относится ровно к директории запуска; внутри Git — к идентичности origin, либо общему git-dir без origin. Политика проверяется перед отправкой, чтением архива, статистикой и чтением журнала. Для другого проекта можно разрешить только конкретную пару или запретить всё. Редактирование и удаление описаны в [политиках доступа](docs/ACCESS_POLICIES.md).

Общая база в Windows: `%LOCALAPPDATA%/Teleprompt/runtime.sqlite`; Linux/macOS: `${XDG_DATA_HOME:-~/.local/share}/teleprompt/runtime.sqlite`. Абсолютный `TELEPROMPT_HOME` выбирает другой каталог. Все клиенты и watch должны использовать один каталог и набор токенов.

## Глобальное подключение

Не подключай один сервер одновременно через MCP-конфигурацию и нативный пакет.

**Codex:**

```powershell
codex mcp add teleprompt -- teleprompt mcp
teleprompt config --client codex
```

Вторая команда печатает фрагмент пользовательского `~/.codex/config.toml` с абсолютным entrypoint и общей базой. Сохранённым credentials передача переменных не требуется. Для старых env-профилей генерируется env_vars; значения токенов не печатаются. Не закрепляй workspace одного проекта в глобальной конфигурации: используется MCP root клиента или cwd запуска. [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

**Claude Code:**

```powershell
claude mcp add --transport stdio --scope user teleprompt -- teleprompt mcp
```

User scope делает сервер доступным из разных проектов. [Claude Code MCP](https://code.claude.com/docs/en/mcp).

**OpenCode:**

```powershell
teleprompt config --client opencode
```

Объедини напечатанный `mcp.teleprompt` с пользовательским `~/.config/opencode/opencode.json` / `.jsonc`. Для V2 используй `--client opencode-v2`, где сервер расположен в `mcp.servers.teleprompt`. Генератор только печатает фрагмент и не перезаписывает настройки. [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), [OpenCode V2 MCP](https://opencode.ai/v2/docs/mcp-servers).

Нативные compatibility-пакеты: `.codex-plugin/plugin.json` + `.mcp.codex.json` и `.claude-plugin/plugin.json` + `.mcp.json`. Общий skill — `skills/telegram-control`. Распространяй их с собранным `dist/cli.js`. Нативная загрузка пока UNVERIFIED; публикация в каталог не выполнена. [OpenAI packaging](https://developers.openai.com/plugins/build/plugins), [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference).

## Сбор и операции

```powershell
teleprompt watch
teleprompt messages --target community --limit 30
teleprompt stats --target community --since 2026-10-01T00:00:00Z
teleprompt send --target community --text "Публикация" --request-id post-community-001
teleprompt edit --target community --message-id 123 --text "Обновлённая публикация" --request-id edit-community-001
teleprompt audit
```

`watch` работает отдельным процессом до Ctrl+C; `--bot news` выбирает одного бота. Автостарт службы пока не реализован. Один бот должен иметь одного владельца update stream. Неподключённые чаты не архивируются, но их обновления также подтверждаются; нельзя делить бота с другим getUpdates-приложением. Активный webhook не удаляется. [Telegram Bot API](https://core.telegram.org/bots/api).

Повтор успешного `request_id` с тем же действием возвращает сохранённый результат. Потеря ответа оставляет `unknown`, прерывание процесса может оставить `pending`. Перед новым запросом нужно проверить журнал и Telegram. Это защита от автоматических дублей, не гарантия exactly-once от Telegram.

Skill требует прямого указания человека на внешнюю запись. Явное «опубликуй этот текст в community» уже разрешает действие. Сообщения группы — данные, а не разрешение на публикации или изменение настроек.

## Проверки

Следующий этап: оба способа подключения ботов, сохранённые пользовательские сессии, создание ботов/чатов и модерация с отдельными правами. [Архитектура account control](docs/ACCOUNT_CONTROL.md) описывает принятое направление; эти возможности пока не входят в реализацию 0.2.

```powershell
npm run check
npm pack --dry-run
```

`npm run check` использует поддельный Telegram transport и настоящий MCP-клиент; сообщения не отправляет.

Отдельный живой тест запускается только для разрешённого пользователем тестового адресата:

```powershell
npm run test:live -- --target TARGET_ALIAS --bot BOT_ALIAS
```

Он создаёт временный текст, проверяет replay/conflict, правку, pin/unpin, collector, архив, статистику и запрет доступа из посторонней директории. Затем удаляет своё сообщение и наблюдённое уведомление о его закреплении. JSON-отчёт записывается в игнорируемую `.teleprompt/`; токены и приватные invite links в него не попадают. При неизвестном исходе запись автоматически не повторяется. [Результат живой проверки](docs/LIVE_ACCEPTANCE.md).

# Политики доступа

Будущие пользовательские аккаунты и операции создания/модерации получат отдельные разрешения. Существующие all/write/manage не будут автоматически открывать эти возможности. Контракт и план миграции описаны в [ACCOUNT_CONTROL.md](ACCOUNT_CONTROL.md#разрешения); ниже — реализованные правила 0.2.

Политика относится к workspace запуска, а не к тексту запроса агента. Каждая операция сначала проверяет связанную политику. Публикация не принимает аргумент «другой workspace». Названия и описания помогают выбрать аудиторию, но разрешения задаются явно.

## Контекст

В MCP используется одна file-root рабочей области клиента. При смене roots контекст обновляется; несколько roots или ошибка их чтения блокируют операции до явной настройки. Если клиент не предоставляет roots, используется cwd дочернего процесса. TELEPROMPT_WORKSPACE задаёт явный абсолютный контекст процесса, когда клиент не передаёт правильную директорию; его нельзя фиксировать на один проект в общей конфигурации нескольких проектов. [MCP roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots).

Git-проект получает ключ из нормализованного origin: HTTPS и SSH одного репозитория совпадают, URL credentials/query не сохраняются в идентичности. Без origin используется абсолютный common git-dir. Подкаталоги и worktrees одного проекта разделяют политику. Без Git ключ — точная каноническая директория; дочерний каталог не наследует разрешение. Другая идентичность Git после изменения origin потребует своей привязки. [Git rev-parse](https://git-scm.com/docs/git-rev-parse), [Git remote](https://git-scm.com/docs/git-remote).

## Режимы

| Режим | Доступ |
|---|---|
| all | Чтение/запись всех зарегистрированных пар бот+чат |
| selected | Только явные пары, с отдельными read/write флагами |
| deny | Telegram-данные и операции запрещены |
| Без привязки | Только каталог имён/описаний для согласования первоначальной настройки |

Write также требует read и локального writable у чата. Manage разрешает администрировать profiles/policies/bindings и глобальный collector; это отдельное полномочие. Выбранный bot должен совпадать с неизменяемым bot_alias указанного target. Группа с несколькими ботами представлена отдельными target alias для каждой пары.

Обычный ограниченный workspace не может повысить себе права, изменить чужую политику, удалить запрет или читать чужие результаты операций. В первоначальной настройке можно создать новую политику для текущего workspace после указания человека. Без привязки нельзя перезаписать уже существующую shared policy. Удаление policy удаляет её bindings и снова блокирует данные до новой настройки. Изменения действуют в уже работающих сессиях.

## CLI

Запускай управление из разрешённого management-проекта. Для локального владельца существует явный --admin у конфигурационных/collector команд. Этот флаг не разрешён для MCP, send, inspect, messages и прочих data/publication-команд. Он не даёт отправлять в обход политики.

```powershell
# Текущий проект управления:
teleprompt init --allow-all --manage --policy development
teleprompt policies current
teleprompt policies list

# Правило только для community; bot берётся из неизменяемого target:
teleprompt policies set --policy project-one --mode selected --allow community --access write
teleprompt policies bind --policy project-one --directory F:/projects/ProjectOne

# Полный запрет в другом проекте:
teleprompt policies set --policy no-telegram --mode deny
teleprompt policies bind --policy no-telegram --directory F:/projects/ProjectTwo

# Редактирование требует актуальной revision:
teleprompt policies set --policy project-one --mode selected --allow community --access read --revision 1
teleprompt policies unbind --scope 'git:example.com/team/project' --policy project-one
teleprompt policies delete --policy project-one --revision 2
```

Policies хранятся отдельно от bindings: одну политику можно назначить нескольким проектам/директориям. Set меняет правило для всех её bindings; bind создаёт или меняет назначение выбранного workspace; unbind удаляет только назначение. Scope key и revision следует брать из current/list, а не угадывать. Configure создаёт/назначает политику текущему workspace.

## Описания и credentials

`telegram_register_bot` / `telegram_update_bot` принимают токен из чата или обычного чтения файла. Возвращаются только метаданные. `telegram_register_chat` принимает ссылку/@username/числовой ID, название, описание и writable. Update меняет описания и локальное writable, сохраняя bot/chat routing. Замена bot token проверяет прежнюю Telegram-идентичность.

Tokens зашифрованы AES-256-GCM в bot_secrets. credentials.key хранится в том же пользовательском каталоге, отдельно от SQLite. Перезапуски и разные клиенты пользуются одними credentials. Для переноса нужны база и key. Это локальный контроль для доверенного пользователя и клиента: доступ к файлам владельца/административному CLI даёт возможность менять локальную конфигурацию. Политика управляет разрешёнными адресатами; описание аудитории и прямое поручение человека определяют, подходит ли конкретное содержимое.

# Живая проверка — Telegram 0.2

Результат: **PASS** для текстового цикла через настоящий MCP stdio-процесс и Telegram Bot API. Прогон `live-d93050dd-2fcb-434b-97f4-ce4a0be3c57e`, 2026-10-04, 10:27 UTC. Пользователь разрешил проверку тестового канала. Токен и приватные ссылки в отчёт не включены.

Использованы сохранённые локальные profiles `teleprompt-test` / `teleprompt-test-channel`, бот `@Telepr0mpt_bot`, канал `@Telepr0mpt_bot_test` (`-1004305678092`). Credentials загружены из зашифрованной базы; токен повторно не вводился. MCP запущен из посторонней папки; клиент передал root проекта Teleprompt. Применена policy `teleprompt-development` для `git:github.com/lotargo/teleprompt`. Сервер объявил 27 tools.

| Проверка | Результат и свидетельство |
| --- | --- |
| Inspection | getMe/getChat/getChatMemberCount/getChatMember; administrator, два участника |
| Публикация | sendMessage вернул message_id=2 в ожидаемом chat_id |
| Повтор | тот же request_id вернул replayed=true и message_id=2; в архиве одна публикация с меткой прогона |
| Конфликт | другой текст с прежним request_id отклонён IDEMPOTENCY_CONFLICT |
| Правка | editMessageText вернул изменённый текст для message_id=2; архив сохранил новую версию |
| Закрепление | pinChatMessage=true; getChat.pinned_message.message_id=2 |
| Открепление | unpinChatMessage=true; getChat больше не содержит закрепления; до теста закреплений не было |
| Collector | получен один update: служебное уведомление message_id=3 о закреплении тестовой публикации; next_offset=918239977 |
| Поиск | поиск по метке прогона вернул одну публикацию с изменённым текстом |
| Другая директория | после смены MCP root отправка и архив отклонены POLICY_REQUIRED; запрос не попал в operations — OPERATION_NOT_FOUND |
| Удаление | deleteMessage=true для message_id=2 и связанного служебного message_id=3; обе записи отмечены удалёнными локально |
| Статистика | observed_messages=2, locally_deleted_messages=2; это публикация и служебное уведомление, с явным partial coverage |
| Audit | шесть успешных операций: send, edit, pin, unpin и два delete; replay/conflict/запрет не создали лишних операций |
| Новый процесс | отдельный CLI подтвердил audit и изменённый текст с deleted=1; sync вернул received=0 и прежний next_offset |

Тестовые сообщения удалены, прежнее состояние закрепления восстановлено. Другим проектам и директориям новые разрешения не назначались. Исходный JSON без credentials находится локально в `.teleprompt/live-acceptance.json` и игнорируется Git. Повторяемый сценарий: `npm run test:live -- --target TARGET_ALIAS --bot BOT_ALIAS`.

Результат подтверждён ответами Bot API и локальным состоянием; визуальный просмотр в Telegram-клиенте не выполнялся. Своя публикация и правка попали в архив из ответов send/edit; этот прогон не проверяет получение внешнего сообщения и его правки через getUpdates. Канальные публикации имеют sender_chat, поэтому bot_messages=0 в этой статистике не означает отсутствие отправки ботом.

Медиа, второй живой бот/адресат, внешние публикации/правки через collector, реальные ограничения частоты, native plugin loading и полный агентский сценарий во всех трёх клиентах остаются **UNVERIFIED**. Архив не содержит произвольную старую историю Telegram.

# Проверка 0.2

Локальная платформа: Windows. `npm run check` включает проверку типов, сборку и 39 поведенческих/интеграционных тестов. Все 39 проходят на Node.js 26.1.0 и отдельно на 22.13.1. Собранный entrypoint запускается без node_modules из отдельной папки. CLI-проверки покрывают отрицательные chat_id и конфигурации без токенов.

Тесты используют поддельный Telegram transport. Проверяются несколько адресатов, readonly, request_id при повторе/изменении/concurrency, unknown после потерянного ответа, отказ/429 без retry, token redaction, webhook conflict, leases между SQLite-соединениями, атомарность offsets, повторы обновлений, версии правок, поиск/пагинация, локальный delete, partial coverage.

MCP: SDK-клиент в памяти и настоящий subprocess/stdin/stdout из посторонней папки; tool discovery, annotations, schema rejection, fake publication и replay без второго send.

Новые проверки: политика выбранной пары/readonly/deny, default deny, запрет отправки конфиденциального текста в недоступную публичную группу до сетевого вызова, изоляция audit/replay, запрет повышения полномочий, ревизии, отзыв в активной сессии, удаление bindings/policies, точные директории, идентичность Git через SSH/HTTPS, шифрование и перезапуск credentials, token rotation и migration v1. MCP roots проверяются при старте/смене и неоднозначном контексте; аргумент tool не может сменить workspace.

`claude plugin validate .` и валидатор skill проходят. Это подтверждает структуру файлов, но не установку или доступ к Telegram.

Живая регистрация и inspection проверены для supplied test bot/channel: getMe, getChat, getChatMemberCount, getChatMember. Подтверждены статус administrator и права post/edit/delete, токен сохранён локально и используется в следующем процессе без переменной среды. Подробности без секретов: [LIVE_ACCEPTANCE.md](LIVE_ACCEPTANCE.md).

Живой MCP stdio → реальный Bot API: публикация текста, replay прежнего message_id, отклонение изменённого текста с тем же request_id, правка, проверка pin/unpin через getChat, удаление и архивный tombstone — **PASS**. Проверены поиск, частичная статистика, audit после нового CLI-запуска, получение служебного update и продолжение по offset. При смене MCP root на новую директорию отправка/чтение отклонены POLICY_REQUIRED; операция отправки не создана. Временная публикация и уведомление о закреплении удалены. Подробности: [LIVE_ACCEPTANCE.md](LIVE_ACCEPTANCE.md).

Медиа-доставка, получение чужой публикации и её правки через collector, лимиты реального Telegram, два живых бота/адресата, native plugin loading и полный end-to-end через три агентских интерфейса **UNVERIFIED**. Визуальная проверка в Telegram-клиенте не выполнялась; результаты подтверждены ответами Bot API, getChat и локальным архивом. Клиенты при разработке: Codex CLI 0.160.0, OpenCode 1.18.34, Claude Code 2.1.39.

const express = require('express');
const https = require('https');
const fetch = require('node-fetch');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const app = express();
const port = 3000;

// Создаем роутер для префикса /nat-cat-1/
const router = express.Router();

// Разрешаем обработку JSON-запросов
app.use(express.json());

// Добавляем CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Обслуживаем статические файлы из папки "public" по префиксу /nat-cat-1/
app.use('/nat-cat-1', express.static('public'));

// Переменные для отслеживания лимитов
const MAX_REQUESTS = 100;
const TIME_WINDOW = 5 * 60 * 1000; // 5 минут в миллисекундах
let requestTimestamps = []; // Массив временных меток запросов
let windowStartTime = Date.now(); // Время начала текущего временного окна

// Функция для очистки устаревших временных меток
function cleanupOldTimestamps() {
    const now = Date.now();
    // 'Окно' начинается с самого старого запроса и длится TIME_WINDOW
    // Удаляем только те, что строго за его пределами
    const cutoffTime = now - TIME_WINDOW;
    requestTimestamps = requestTimestamps.filter(timestamp => timestamp > cutoffTime);

    // Если все метки удалены, обновляем windowStartTime
    if (requestTimestamps.length === 0) {
        windowStartTime = now;
    } else {
        // Иначе, windowStartTime - это самая ранняя оставшаяся метка
        windowStartTime = requestTimestamps[0];
    }
}

// --- НАЧАЛО: Определение middleware для проверки лимита ---
function checkRateLimit(req, res, next) {
    const now = Date.now();

    // Очищаем устаревшие временные метки
    cleanupOldTimestamps();

    // Проверяем, не превышен ли лимит в текущем временном окне
    if (requestTimestamps.length >= MAX_REQUESTS) {
        // Вычисляем время до освобождения следующего слота
        const oldestTimestamp = requestTimestamps[0];
        const timeUntilNextSlot = Math.ceil((oldestTimestamp + TIME_WINDOW - now) / 1000);

        return res.status(429).json({
            error: 'Лимит запросов исчерпан',
            retryAfter: timeUntilNextSlot,
            message: `Достигнут лимит ${MAX_REQUESTS} запросов за 5 минут. Следующий запрос будет доступен через ${timeUntilNextSlot} секунд.`
        });
    }

    // Добавляем временную метку текущего запроса
    requestTimestamps.push(now);
    next();
}
// --- КОНЕЦ: Определение middleware для проверки лимита ---

// Прокси-маршрут (теперь использует именованное middleware)
router.post('/proxy', checkRateLimit, async (req, res) => {
    const apiUrl = 'https://апи.национальный-каталог.рф/v4/rd-info-by-gtin?apikey=842v3mtua2hlaa1k';
    console.log('Отправка запроса к API НКТ:', apiUrl);
    console.log('Тело запроса:', req.body);

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Accept-Charset': 'utf-8',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(req.body),
        });

        console.log('Статус ответа:', response.status);
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Ошибка API:', response.status, errorText);
            return res.status(response.status).json({ error: errorText });
        }

        const data = await response.json();
        console.log('Ответ API:', data);

        // Очищаем устаревшие временные метки и получаем оставшееся количество запросов перед отправкой ответа
        cleanupOldTimestamps(); // Обновляем состояние перед отправкой заголовков
        const remainingRequests = MAX_REQUESTS - requestTimestamps.length;
        const timeUntilReset = requestTimestamps.length > 0 ? Math.ceil((requestTimestamps[0] + TIME_WINDOW - Date.now()) / 1000) : 0;

        // Устанавливаем заголовки с информацией о лимитах
        res.set({
            'X-RateLimit-Limit': MAX_REQUESTS,
            'X-RateLimit-Remaining': Math.max(0, remainingRequests),
            'X-RateLimit-Reset': requestTimestamps.length > 0 ? requestTimestamps[0] + TIME_WINDOW : Date.now(),
            'X-RateLimit-RetryAfter': timeUntilReset
        });

        res.json(data);
    } catch (error) {
        console.error('Ошибка при запросе к API:', error);
        res.status(500).json({ error: 'Произошла ошибка при запросе к API', details: error.message });
    }
});

// --- Новый маршрут для product-list ---
// Удаляем жестко закодированные параметры
const API_KEY = '842v3mtua2hlaa1k'; // Используем тот же ключ, что и в оригинальном proxy

// Маршрут для нового метода product-list
// Используем GET, так как API документирует его как GET запрос
// Параметры будут передаваться в URL-строке запроса
router.get('/proxy-product-list', checkRateLimit, async (req, res) => {
    // Получаем параметры из query string
    const { from_date, to_date, limit, offset } = req.query;

    // Валидация параметров (простая)
    // from_date и to_date - строка в формате YYYY-MM-DD HH:mm:ss
    // limit - число, 1-1000
    // offset - число, >= 0
    let validationErrors = [];
    if (from_date && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(from_date)) {
        validationErrors.push('Параметр from_date должен быть в формате YYYY-MM-DD HH:mm:ss');
    }
    if (to_date && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(to_date)) {
        validationErrors.push('Параметр to_date должен быть в формате YYYY-MM-DD HH:mm:ss');
    }
    if (limit !== undefined) {
        const parsedLimit = parseInt(limit);
        if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 1000) {
            validationErrors.push('Параметр limit должен быть числом от 1 до 1000');
        }
    }
    if (offset !== undefined) {
        const parsedOffset = parseInt(offset);
        if (isNaN(parsedOffset) || parsedOffset < 0) {
            validationErrors.push('Параметр offset должен быть числом >= 0');
        }
    }

    if (validationErrors.length > 0) {
        console.error('Ошибка валидации параметров:', validationErrors);
        return res.status(400).json({ error: 'Неверные параметры запроса', details: validationErrors });
    }

    // Формируем URL с параметрами из query string
    const params = new URLSearchParams();
    params.append('apikey', API_KEY);
    if (from_date) params.append('from_date', from_date);
    if (to_date) params.append('to_date', to_date);
    if (limit) params.append('limit', limit);
    if (offset !== undefined) params.append('offset', offset); // offset может быть 0

    const apiUrl = `https://апи.национальный-каталог.рф/v4/product-list?${params.toString()}`;

    console.log('Отправка запроса к API НКТ (product-list):', apiUrl);

    try {
        // GET-запрос, тело не передаем
        const response = await fetch(apiUrl, {
            method: 'GET', // Указываем метод GET
            headers: {
                'Accept-Charset': 'utf-8',
                'Content-Type': 'application/json',
                // Если для этого метода требуется Authorization header (Bearer token), добавьте его:
                // 'Authorization': 'Bearer ' + ВАШ_ТОКЕН
            },
            // body не нужен для GET
        });

        console.log('Статус ответа (product-list):', response.status);
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Ошибка API (product-list):', response.status, errorText);
            // Возвращаем ошибку с тем же статусом, что и от API
            return res.status(response.status).json({ error: errorText });
        }

        const data = await response.json();
        console.log('Ответ API (product-list):', data); // Для отладки

        // Очищаем устаревшие временные метки и получаем оставшееся количество запросов перед отправкой ответа
        cleanupOldTimestamps(); // Обновляем состояние перед отправкой заголовков
        const remainingRequests = MAX_REQUESTS - requestTimestamps.length;
        const timeUntilReset = requestTimestamps.length > 0 ? Math.ceil((requestTimestamps[0] + TIME_WINDOW - Date.now()) / 1000) : 0;

        // Устанавливаем заголовки с информацией о лимитах (аналогично /proxy)
        res.set({
            'X-RateLimit-Limit': MAX_REQUESTS,
            'X-RateLimit-Remaining': Math.max(0, remainingRequests),
            'X-RateLimit-Reset': requestTimestamps.length > 0 ? requestTimestamps[0] + TIME_WINDOW : Date.now(),
            'X-RateLimit-RetryAfter': timeUntilReset
        });

        // Возвращаем успешный ответ
        res.json(data);

    } catch (error) {
        console.error('Ошибка при запросе к API (product-list):', error);
        res.status(500).json({ error: 'Произошла ошибка при запросе к API', details: error.message });
    }
});
// --- Конец нового маршрута ---

// Маршрут для получения статуса лимитов
router.get('/rate-limit-status', (req, res) => {
    cleanupOldTimestamps(); // Обновляем состояние перед отправкой статуса
    const now = Date.now();
    const remainingRequests = MAX_REQUESTS - requestTimestamps.length;
    const timeUntilReset = requestTimestamps.length > 0 ? Math.ceil((requestTimestamps[0] + TIME_WINDOW - now) / 1000) : 0;
    const isPaused = requestTimestamps.length >= MAX_REQUESTS;
    const windowEnd = windowStartTime + TIME_WINDOW;

    res.json({
        limit: MAX_REQUESTS,
        remaining: Math.max(0, remainingRequests),
        used: requestTimestamps.length,
        isPaused: isPaused,
        timeUntilReset: timeUntilReset, // Сколько секунд осталось до сброса
        currentWindowStart: windowStartTime,
        currentWindowEnd: windowEnd
    });
});

// Используем роутер для префикса /nat-cat-1
app.use('/nat-cat-1', router);

// Запуск сервера
app.listen(port, () => {
    console.log(`Прокси-сервер запущен на http://server-rep:${port}/nat-cat-1/`);
});
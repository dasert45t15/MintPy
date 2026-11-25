<div align="center">

<img src="assets/mintpy-logo.png" width="156" alt="MintPy logo">

# MintPy

### Атмосферный Zen-аудиоплеер для Windows и Android: нативный C++20/WebView2 движок, живые WebGL-обои, аудиореактивные анимации и перенос плейлистов

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-0078D4?style=flat-square&logo=windows)](../../releases)
[![Desktop](https://img.shields.io/badge/Desktop-C%2B%2B20%20%2B%20WebView2-00599C?style=flat-square&logo=cplusplus)](native/CMakeLists.txt)
[![Android](https://img.shields.io/badge/Android-Java%20Service%20%2B%20IndexedDB-3DDC84?style=flat-square&logo=android)](android/AndroidManifest.xml)
[![Version](https://img.shields.io/badge/version-6.0.0-emerald?style=flat-square)](../../releases)
[![License](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](LICENSE)

[Скачать релиз](../../releases) · [Возможности](#возможности) · [Архитектура проекта](#архитектура-и-структура-проекта) · [Сборка и тесты](#разработка-и-сборка)

</div>

---

**MintPy v6.0** — лёгкий модульный аудиоплеер с нулевыми внешними npm-зависимостями: нативный клиент для Windows (`~5 МБ` C++20 + WebView2) и мобильное приложение для Android (`~2.5 МБ` APK с фоновым `PlaybackService` и `IndexedDB`). Объединяет локальную фонотеку, мгновенный онлайн-поток с YouTube, импорт плейлистов в один клик из Яндекс Музыки, YouTube и Spotify, караоке-тексты песен (`LRCLIB`), синтезатор звуков природы, живые WebGL-шейдеры и богатую GPU-хореографию интерфейса.

---

## Возможности

### 🎵 Звуковой движок и стриминг
- **Локальная музыка**: поддержка `MP3`, `FLAC`, `OGG`, `M4A` и `WAV` с нативным C++ сканером метаданных и обложек (`native/src/tag_scanner.cpp`).
- **Устойчивый онлайн-поток**: многоуровневый резолвер (`ANDROID_VR` → `IOS` → `ANDROID` → `WEB_REMIX` → `Piped` / `yt-dlp`) и защищённый локальный loopback-прокси (`127.0.0.1`).
- **Dual-Deck WebAudio**: бесшовный кроссфейд (`0–12 с`), адаптивная RMS-нормализация громкости и 3-полосный эквалайзер (на Android — аппаратный `Equalizer` в `PlaybackService`).
- **Перенос плейлистов**: импорт по ссылке из **Яндекс Музыки**, **Spotify** и **YouTube / YouTube Music**, а также двусторонний JSON-бэкап между ПК и Android.

### ✨ Живая визуальная хореография и темы
- **6 миров на ПК и 9 тем на Android** (каждая в Dark и Light режимах): *Japanese Zen*, *Parisian Lo-Fi*, *Deep Ocean*, *Synthwave 80s*, *Boreal Forest*, *Glass Aurora* (+ мобильные *Sakura Night*, *Midnight Gold*, *Cyberpunk*).
- **Живые WebGL-обои** (`wallpaper-shader.js`) и процедурные частицы (`sakura.js`) с параллаксом от курсора на ПК и энергоэффективным рендером на телефоне.
- **Аудиореактивные и тактильные анимации (`v6.0`)**:
  - **ПК (`src/ui-fx.js`)**: живой радиальный WebAudio-спектр вокруг виниловой пластинки, интерактивный 3D-наклон карточек со световым бликом, частицы-искры при лайке, рипплы и плавная вуаль смены темы.
  - **Android (`src_mobile/ui-fx.js`)**: свайп влево/вправо по виниловой сцене и мини-плееру с пружинной физикой для переключения треков, направленные переходы между вкладками, звуковые кольца и touch-рипплы.
- **Тематический плавающий Mini-Player** на ПК (Always-on-Top, анимированный винил и тонарм, цвета активной темы), **интерактивные питомцы**, **Discord Rich Presence**, **караоке-тексты `LRCLIB`**, **5 слоёв звуков природы** и **таймер сна с плавным затуханием**.

---

## Установка

Готовые сборки на странице [Releases](../../releases):

- **`MintPy-Setup-v6.0.0.exe`** — компактный установщик Windows x64 (`~14 МБ`).
- **`MintPy-Portable-v6.0.0-win64.zip`** — портативная версия для Windows x64 без установки.
- **`MintPy-v6.0.0.apk`** — подписанный APK для Android 7.0+ (`~2.5 МБ`, схемы подписи `v2/v3`).

---

## Архитектура и структура проекта

Весь проект разделён на небольшие изолированные модули с **единым источником версии** в [`package.json`](package.json):

```text
mintpy/
├── native/                 # Нативный Windows-клиент (C++20, Win32, WebView2, WinHTTP, Winsock2)
│   ├── include/            # Заголовки и JS-мост WebView2 (js_bridge.h)
│   ├── src/                # main.cpp, http_client.cpp, audio_proxy.cpp, data_store.cpp, tag_scanner.cpp, discord_ipc.cpp
│   └── res/                # Иконка приложения (относительный путь)
├── android/                # Чистый Android-проект (Java + XML, без генерации из строк)
│   ├── AndroidManifest.xml # Манифест (версия подставляется автоматически при сборке)
│   ├── res/values/         # Строки и системная тема
│   └── java/com/mintpy/app/# MainActivity.java, PlaybackService.java, LocalAudioProxy.java
├── shared/                 # Общие модули без дублирования (ПК + Android + Node-тесты)
│   ├── utils.js            # Версия, экранирование, парсер LRC, роутер плейлистов, парсер поиска
│   ├── lyrics.js           # Синхронизированные караоке-тексты LRCLIB
│   ├── ambient.js          # WebAudio-синтезатор 5 природных слоёв
│   └── sleep-timer.js      # Таймер сна с плавным затуханием громкости
├── src/                    # Десктопный фронтенд
│   ├── css/                # Модульные стили: base.css, themes.css, features.css, mini-player.css, animations.css
│   ├── themes-config.js    # Палитры и локализованные фразы 6 миров
│   ├── ui-fx.js            # Радиальный спектр винила, 3D-наклон, искры и переходы
│   ├── wallpaper-shader.js # WebGL-шейдеры живых обоев ПК
│   ├── pets.js / sakura.js # Компаньоны и частицы
│   └── main.js             # Контроллер десктопного плеера
├── src_mobile/             # Мобильный фронтенд (оптимизирован под сенсорные экраны)
│   ├── css/                # Модульные стили: base.css, themes.css, player.css, animations.css
│   ├── bridge/             # storage.js (IndexedDB), youtube.js, importers.js, mobile-bridge.js
│   ├── themes-config.js    # Конфигурация 9 мобильных тем и пресетов эквалайзера
│   ├── ui-fx.js            # Жесты свайпа треков, тач-рипплы и переходы вкладок
│   └── main.js             # Контроллер мобильного плеера
├── scripts/                # Скрипты проверки и сборки (build-cpp, build-installer, build-android-apk, build-all)
└── tests/                  # Автотесты целостности архитектуры, путей, CSS-ассетов и общих модулей
```

---

## Разработка и сборка

Внешние `npm`-пакеты не требуются (`node_modules` отсутствует). Для проверки и полной сборки:

```powershell
# Проверка синтаксиса всех JS-модулей
npm run check

# Запуск архитектурных и модульных тестов (проверяет все ссылки HTML/CSS, пути и парсеры)
npm test

# Сборка отдельных платформ
npm run build:native      # -> releases/MintPy-Native.exe
npm run build:installer   # -> releases/MintPy-Setup.exe + MintPy-Portable-v6.0.0-win64.zip
npm run build:apk         # -> releases/MintPy-v6.0.0.apk

# Полная проверка + сборка всех релизов одной командой
npm run build:all
```

> Чтобы выпустить новую версию, достаточно поменять поле `"version"` **только в одном файле [`package.json`](package.json)** и скорректировать бейдж в `README.md` — все установщики, архивы и Android `AndroidManifest.xml` подхватят её автоматически, а старые сборки в `releases/` очистятся сами.

---

## Автор и Лицензия

- **Автор и создатель проекта**: **Иван** ([Dasert](https://github.com/dasert45t15) / **Волтер**).
- Лицензия: **MIT** ([LICENSE](LICENSE)).

# 🚀 Руководство по развёртыванию Clean Cinema

## 1. Запуск на ПК (локально)

### Windows
```
start_local.bat
```
Откроется сервер на `http://localhost:8000`.
На телефоне в той же Wi-Fi сети откройте адрес, показанный в консоли (например, `http://192.168.1.45:8000`).

### Вручную
```bash
python -m venv venv
venv\Scripts\activate   # Windows
source venv/bin/activate # macOS/Linux
pip install -r requirements.txt
uvicorn server.main:app --host 0.0.0.0 --port 8000
```

---

## 2. Бесплатный облачный хостинг (Render.com)

Сайт будет работать 24/7 по адресу `https://ваше-имя.onrender.com` без включённого ПК.

### Шаги:
1. Создайте аккаунт на [render.com](https://render.com) (бесплатно, через Google/GitHub).
2. Загрузите проект на GitHub:
   ```bash
   cd clean-cinema
   git init
   git add .
   git commit -m "Clean Cinema initial"
   ```
   Создайте новый **приватный** репозиторий на GitHub и загрузите код.
3. На Render нажмите **New → Web Service** → подключите репозиторий.
4. Настройки:
   - **Runtime**: Python
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn server.main:app --host 0.0.0.0 --port $PORT`
   - **Plan**: Free
5. Нажмите **Deploy** — через 2-3 минуты сайт будет готов.

> ⚠️ На бесплатном плане Render сервис «засыпает» после 15 минут бездействия.
> Первое открытие после простоя занимает ~30 секунд. Далее работает моментально.

---

## 3. Добавление на экран телефона (как приложение)

### iPhone (Safari):
1. Откройте адрес сайта в Safari.
2. Нажмите кнопку «Поделиться» (□↑).
3. Выберите **«На экран Домой»**.
4. Сайт появится как полноценное приложение без рамки браузера.

### Android (Chrome):
1. Откройте адрес сайта в Chrome.
2. Нажмите **⋮** → **«Добавить на главный экран»** или **«Установить приложение»**.

---

## 4. VPS в Казахстане (если нужна постоянная скорость)

### Рекомендуемые хостинги с оплатой Kaspi Gold:

| Хостинг | Цена от | Оплата Kaspi |
|---------|---------|--------------|
| [Timeweb Cloud](https://timeweb.cloud) | ~1 000 ₸/мес | ✅ Visa/MC |
| [PS.kz](https://ps.kz) | ~3 100 ₸/мес | ✅ Kaspi |
| [Hoster.kz](https://hoster.kz) | ~3 100 ₸/мес | ✅ Kaspi |
| [Serverspace.kz](https://serverspace.kz) | ~2 978 ₸/мес | ✅ |

### Установка на VPS (Ubuntu):
```bash
apt update && apt install -y python3 python3-venv python3-pip git
git clone <ваш-репозиторий> /opt/cinema
cd /opt/cinema
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
# Запуск как сервис
nohup uvicorn server.main:app --host 0.0.0.0 --port 8000 &
```

Для HTTPS настройте Nginx + Let's Encrypt (бесплатный SSL).

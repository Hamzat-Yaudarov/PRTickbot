FROM node:18-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm install --production

# Копируем остальные файлы
COPY . .

# Создаем пользователя для безопасности
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodeuser -u 1001

# Меняем владельца файлов
USER nodeuser

# Открываем порт (Railway автоматически назначит порт)
EXPOSE 3000

# Запускаем бот
CMD ["npm", "start"]

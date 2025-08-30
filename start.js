#!/usr/bin/env node

// Быстрый запуск бота с базовой конфигурацией
console.log('🚀 Запуск TickPiar Bot...\n');

// Проверяем наличие зависимостей
try {
  require('telegraf');
  require('pg');
  console.log('✅ Все зависимости найдены');
} catch (error) {
  console.error('❌ Отсутствуют зависимости. Запустите: npm install');
  process.exit(1);
}

// Проверяем конфигурацию
try {
  const config = require('./config');
  
  if (!config.BOT_TOKEN) {
    throw new Error('Отсутствует BOT_TOKEN');
  }
  
  if (!config.DATABASE_URL) {
    throw new Error('Отсутствует DATABASE_URL');
  }
  
  console.log('✅ Конфигурация к��рректна');
  console.log(`🤖 Бот: ${config.BOT_USERNAME}`);
  console.log(`🗄️ База данных: настроена`);
  
} catch (error) {
  console.error('❌ Ошибка конфигурации:', error.message);
  process.exit(1);
}

// Запускаем основной файл
console.log('\n🔄 Инициализация бота...\n');
require('./index.js');

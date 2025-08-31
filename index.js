const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const db = require('./database');

class TickPiarBot {
  constructor() {
    this.bot = new Telegraf(config.BOT_TOKEN);
    this.userStates = new Map(); // Для хранения состояний пользователей
    this.userCache = new Map(); // Кэш для пользователей
    this.taskCache = new Map(); // Кэш для заданий

    // Очистка кэша каждые 5 минут
    setInterval(() => {
      this.userCache.clear();
      this.taskCache.clear();
    }, 5 * 60 * 1000);

    this.init();
  }

  setupErrorHandlers() {
    // Обработка ошибок Telegraf
    this.bot.catch((err, ctx) => {
      console.error('❌ Ошибка Telegraf:', err);

      if (ctx && ctx.reply) {
        ctx.reply('❌ Произошла ошибка. Попроб��йте позже.')
          .catch(e => console.error('Ошибка отправки сообщения об ошибке:', e));
      }
    });

    // Обработка ошибок Node.js
    process.on('uncaughtException', (error) => {
      console.error('❌ Необработанная ошибка:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('❌ Необработанное отклонение промиса:', reason);
    });
  }

  async init() {
    try {
      console.log('🔄 Инициализация бота...');

      // Сначала инициализируем базу данных
      await db.init();
      console.log('✅ База данн��х инициализирована');

      // Настраиваем обработчики
      this.setupHandlers();
      this.setupErrorHandlers();

      // Graceful shutdown handling
      process.once('SIGINT', () => this.stop('SIGINT'));
      process.once('SIGTERM', () => this.stop('SIGTERM'));

      console.log('🚀 Запускаем бота...');

      // Запускаем бота с retry логикой для обработки 409 ошибки
      await this.launchWithRetry();

      console.log('✅ TickPiar Bot успешно запущен!');
    } catch (error) {
      console.error('❌ Критическая ошибка запуска бота:', error);
      process.exit(1);
    }
  }

  async launchWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.bot.launch();
        return; // Успешный запуск
      } catch (error) {
        console.error(`❌ Попытка запуска ${attempt}/${maxRetries} неудачна:`, error.message);

        if (error.response && error.response.error_code === 409) {
          console.log('⏳ Обнаружен конфликт (409). Ждём завершения другого экземпляра...');

          // Ждем перед повторной попы��кой (экспоненциальная задержка)
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await new Promise(resolve => setTimeout(resolve, delay));

          if (attempt === maxRetries) {
            console.error('❌ Все попытки запуска исчерпаны. Возможно, другой экземпляр бота еще активен.');
            throw error;
          }
        } else {
          // Для др��гих ошибок не повторяем попытки
          throw error;
        }
      }
    }
  }

  async stop(signal) {
    console.log(`🛑 Получен сигнал ${signal}. Завершаем работу бота...`);
    try {
      if (this.bot) {
        await this.bot.stop(signal);
      }
      console.log('✅ Бот корректно завершен');
      process.exit(0);
    } catch (error) {
      console.error('❌ Ошибка при завершении бота:', error);
      process.exit(1);
    }
  }

  setupHandlers() {
    // Команда /start с поддержкой рефералов
    this.bot.start(async (ctx) => {
      const userId = ctx.from.id;
      const referralCode = ctx.startPayload; // Реферальный код из ссылки
      
      await this.registerUser(ctx, referralCode);
      await this.showMainMenu(ctx);
    });

    // Обработка callback-ов от inline кнопок
    this.bot.on('callback_query', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const userId = ctx.from.id;

      try {
        // Отвечаем на callback быстро
        await ctx.answerCbQuery();

        // Добавляем ��ндикатор загрузки только для медленных операций
        let processingMsg = null;
        if (['cabinet', 'referral', 'earn', 'create_task'].includes(data)) {
          try {
            processingMsg = await ctx.reply('⏳ Загрузка...');
          } catch (e) {
            console.error('Ошибка создания индикатора загрузки:', e);
          }
        }

        console.log(`📞 Обработка callback: ${data} от пользователя ${userId}`);

        switch (data) {
          case 'main_menu':
            await this.showMainMenu(ctx);
            break;
          case 'earn':
            await this.showEarnMenu(ctx);
            break;
          case 'promote':
            await this.showPromoteMenu(ctx);
            break;
          case 'cabinet':
            await this.showCabinet(ctx);
            break;
          case 'referral':
            await this.showReferralMenu(ctx);
            break;
          case 'create_task':
            await this.startTaskCreation(ctx);
            break;
          default:
            if (data.startsWith('complete_task_')) {
              const taskId = data.split('_')[2];
              await this.handleTaskCompletion(ctx, taskId);
            } else {
              console.log(`⚠️ Неизвестный callback: ${data}`);
            }
            break;
        }

        // Удаляем индикатор загрузки если он был создан
        if (processingMsg) {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
          } catch (e) {
            // Игнорируем ошибки удаления (сообщение могло быть уже удалено)
            console.log('Индикатор загрузки уже удален или недоступен');
          }
        }

        console.log(`✅ Callback ${data} обработан успешно`);

      } catch (error) {
        console.error(`❌ Ошибка обработки callback '${data}':`, error);

        // Пытаемся сообщить пользователю об ошибке различными способами
        const errorMsg = '❌ Произошла ошибка. Попробуйте позже или перезапустите бота командой /start';

        try {
          if (ctx.callbackQuery) {
            await ctx.answerCbQuery(errorMsg, { show_alert: true });
          }
        } catch (cbError) {
          console.error('Ошибка answerCbQuery:', cbError);
        }

        try {
          await ctx.reply(errorMsg);
        } catch (replyError) {
          console.error('Ош��бка отправки сообщения об ошибке:', replyError);
        }
      }
    });

    // Обраб��тка текстовых сообщений для создания заданий
    this.bot.on('text', async (ctx) => {
      const userId = ctx.from.id;
      const userState = this.userStates.get(userId);

      if (userState) {
        await this.handleTaskCreationStep(ctx, userState);
      }
    });

    // Обработка добавления бота в групповые чаты
    this.bot.on('my_chat_member', async (ctx) => {
      const chatMember = ctx.myChatMember;
      const chat = ctx.chat;
      
      if (chatMember.new_chat_member.status === 'member' || chatMember.new_chat_member.status === 'administrator') {
        if (chat.type === 'group' || chat.type === 'supergroup') {
          // Бот добавлен в групповой чат
          await this.handleBotAddedToGroup(ctx);
        }
      }
    });

    // Обработка новы�� участников в группах (для проверки подписок)
    this.bot.on('new_chat_members', async (ctx) => {
      await this.checkSponsorSubscriptions(ctx);
    });

    // Обработка сообщений в группах (проверка спонсорс��их подписок)
    this.bot.on('message', async (ctx) => {
      if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await this.checkUserCanSendMessage(ctx);
      }
    });
  }

  // Регистрация пользователя
  async registerUser(ctx, referralCode = null) {
    const user = ctx.from;
    console.log(`👤 Регистрируем пользователя ${user.id}: ${user.first_name} ${user.last_name || ''}`);

    try {
      // Генерируем уникальный реферальный код для пользователя
      const userReferralCode = this.generateReferralCode(user.id);

      const userData = {
        user_id: user.id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        referral_code: userReferralCode
      };

      console.log('💾 Создаем пользователя в базе данных...');
      const createdUser = await db.createUser(userData);

      if (!createdUser) {
        console.error('❌ Не удалось создать пользователя в базе данных');
        return null;
      }

      console.log('✅ Пользователь успешно создан');

      // Обрабатываем реферала если есть
      if (referralCode && createdUser) {
        console.log(`🔗 Обрабатываем реферальный код: ${referralCode}`);
        await this.processReferralCode(referralCode, user.id);
      }

      return createdUser;
    } catch (error) {
      console.error('❌ Ошибка регистрации пользователя:', error);
      return null;
    }
  }

  // Обработка реферального кода
  async processReferralCode(referralCode, newUserId) {
    try {
      // Ищем пользователя по реферальному коду
      const result = await db.pool.query('SELECT user_id FROM users WHERE referral_code = $1', [referralCode]);
      
      if (result.rows.length > 0) {
        const referrerId = result.rows[0].user_id;
        if (referrerId !== newUserId) {
          await db.processReferral(referrerId, newUserId);
        }
      }
    } catch (error) {
      console.error('Ошибка обработки реферального кода:', error);
    }
  }

  // Генерация реферального кода
  generateReferralCode(userId) {
    return `ref_${userId}_${Date.now().toString(36)}`;
  }

  // Главное меню
  async showMainMenu(ctx) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💰 Заработать', 'earn')],
      [Markup.button.callback('📢 Рекламировать', 'promote')],
      [Markup.button.callback('���� Мой кабинет', 'cabinet')],
      [Markup.button.callback('🔗 Реферальная система', 'referral')]
    ]);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(config.MESSAGES.START, keyboard);
    } else {
      await ctx.reply(config.MESSAGES.START, keyboard);
    }
  }

  // Меню "Заработать"
  async showEarnMenu(ctx) {
    try {
      const userId = ctx.from.id;
      console.log(`💰 Загружаем меню заработка для пользователя ${userId}`);

      console.log('📋 Получаем доступные задания...');
      const availableTasks = await Promise.race([
        db.getAvailableTasks(userId, 5), // Ограничиваем до 5 заданий для быстроты
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Database timeout')), 5000)
        )
      ]);

      if (availableTasks.length === 0) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Обновить', 'earn')],
          [Markup.button.callback('⬅️ Назад', 'main_menu')]
        ]);

        const message = '💰 Заработать\n\n❌ Нет ��оступных заданий.\nСоздайте свое задание в разд��ле "Рекламировать"!';

        if (ctx.callbackQuery) {
          await ctx.editMessageText(message, keyboard);
        } else {
          await ctx.reply(message, keyboard);
        }
        return;
      }

      let message = '💰 Доступные задания:\n\n';
      const buttons = [];

      availableTasks.forEach((task, index) => {
        const title = task.channel_title || task.channel_username;
        const shortTitle = title.length > 25 ? title.substring(0, 25) + '...' : title;

        message += `${index + 1}. ${shortTitle}\n`;
        message += `💰 ${task.reward} коинов | 👥 ${task.completed_count}/${task.max_completions}\n`;
        if (task.description && task.description.length > 0) {
          const desc = task.description.length > 30 ? task.description.substring(0, 30) + '...' : task.description;
          message += `📝 ${desc}\n`;
        }
        message += '\n';

        buttons.push([Markup.button.callback(
          `✅ ${index + 1} → ${task.reward} 🪙`,
          `complete_task_${task.task_id}`
        )]);
      });

      buttons.push(
        [Markup.button.callback('�� Обновить', 'earn')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
      );

      const keyboard = Markup.inlineKeyboard(buttons);

      console.log(`📋 Отправляем список из ${availableTasks.length} заданий`);

      if (ctx.callbackQuery) {
        // Проверяем, изменилось ли содержимое сообщения
        const currentMessage = ctx.callbackQuery.message?.text;
        if (currentMessage && currentMessage === message) {
          console.log('⚠️ Содержимое меню заработка не изменилось');
          await ctx.answerCbQuery('✅ Список заданий актуален');
          return;
        }

        await ctx.editMessageText(message, keyboard);
      } else {
        await ctx.reply(message, keyboard);
      }
    } catch (error) {
      console.error('Ошибка показа меню заработка:', error);
      const errorKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Попробовать снова', 'earn')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
      ]);

      const errorMessage = '❌ Ошибка загрузки заданий. Попробуйте снова.';

      if (ctx.callbackQuery) {
        await ctx.editMessageText(errorMessage, errorKeyboard);
      } else {
        await ctx.reply(errorMessage, errorKeyboard);
      }
    }
  }

  // Выполнение задания
  async handleTaskCompletion(ctx, taskId) {
    const userId = ctx.from.id;
    
    try {
      // Получаем информацию о задании
      const taskResult = await db.pool.query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
      if (taskResult.rows.length === 0) {
        await ctx.answerCbQuery('❌ Задание не най��ено');
        return;
      }

      const task = taskResult.rows[0];
      
      // Проверяем подписку на канал с таймаутом
      const isSubscribed = await Promise.race([
        this.checkChannelSubscription(ctx, task.channel_username),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Subscription check timeout')), 5000)
        )
      ]).catch(error => {
        console.error('Ошибка проверки подписки:', error);
        return false;
      });
      
      if (isSubscribed) {
        const completedTask = await db.completeTask(userId, taskId);
        if (completedTask) {
          await ctx.answerCbQuery(`✅ Задание выполнено! +${task.reward} Tick коинов`);
          await this.showEarnMenu(ctx);
        } else {
          await ctx.answerCbQuery('❌ Ошибка выполнения задания');
        }
      } else {
        const subscribeUrl = `https://t.me/${task.channel_username.replace('@', '')}`;
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.url('📢 Подписаться', subscribeUrl)],
          [Markup.button.callback('✅ Проверить подписку', `complete_task_${taskId}`)],
          [Markup.button.callback('⬅️ Назад', 'earn')]
        ]);
        
        await ctx.editMessageText(
          `📢 Для выполнения задания подпишитесь на канал:\n\n` +
          `🔗 ${task.channel_username}\n` +
          `💰 Награда: ${task.reward} Tick коинов\n\n` +
          `После подписки нажмите "Проверить подписку"`,
          keyboard
        );
      }
    } catch (error) {
      console.error('Ошибка выполнения задания:', error);
      await ctx.answerCbQuery('❌ Произошла ошибка');
    }
  }

  // Проверка подписки на канал
  async checkChannelSubscription(ctx, channelUsername) {
    try {
      const cacheKey = `${ctx.from.id}_${channelUsername}`;
      const cached = this.userCache.get(cacheKey);

      // Кэш на 30 секунд
      if (cached && Date.now() - cached.timestamp < 30000) {
        return cached.subscribed;
      }

      const chatMember = await Promise.race([
        ctx.telegram.getChatMember(channelUsername, ctx.from.id),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 3000)
        )
      ]);

      const subscribed = ['member', 'administrator', 'creator'].includes(chatMember.status);

      // Сохраняем в кэш
      this.userCache.set(cacheKey, {
        subscribed,
        timestamp: Date.now()
      });

      return subscribed;
    } catch (error) {
      console.error('Ошибка проверки подписки:', error);
      return false;
    }
  }

  // Меню "Рекламировать"
  async showPromoteMenu(ctx) {
    const userId = ctx.from.id;
    const user = await db.getUser(userId);
    
    let message = '📢 Рекламировать\n\n';
    message += 'Создавайте задания для продвижения ваших каналов!\n\n';
    message += `💰 Ваш баланс: ${user?.tick_balance || 0} Tick коинов\n`;
    message += `💵 ��инимальная награда: ${config.MIN_TASK_REWARD} коинов\n`;
    message += `💵 Максимальная награда: ${config.MAX_TASK_REWARD} коинов\n\n`;
    message += '⚠️ Награда списывается с вашего баланса при создании задания.';

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Создать задание', 'create_task')],
      [Markup.button.callback('⬅️ Назад', 'main_menu')]
    ]);

    await ctx.editMessageText(message, keyboard);
  }

  // Начало создания задания
  async startTaskCreation(ctx) {
    try {
      const userId = ctx.from.id;
      console.log(`🚀 Начинаем создание задания для пользователя ${userId}`);

      console.log('📊 Получаем данные пользователя...');
      const user = await Promise.race([
        db.getUser(userId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 3000)
        )
      ]);

      console.log(`👤 Данные пользователя:`, user ? 'найдены' : 'не найдены');

      if (!user) {
        console.log('❌ Пользователь не найден в базе данных');
        const errorMsg = '❌ Ошибка: пользователь не найден. Попробуйте /start';

        if (ctx.callbackQuery) {
          await ctx.answerCbQuery(errorMsg);
          await ctx.editMessageText(errorMsg, Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Главное меню', 'main_menu')]
          ]));
        } else {
          await ctx.reply(errorMsg);
        }
        return;
      }

      const minBalance = config.MIN_TASK_REWARD || 15;
      console.log(`💰 Проверяем баланс: ${user.tick_balance} >= ${minBalance}`);

      if (user.tick_balance < minBalance) {
        const errorMsg = `❌ Недостаточно ��редств для создания задания\n💰 Баланс: ${user.tick_balance} Тик коинов\n📊 Нужно: ${minBalance} Тик коинов`;

        console.log(`❌ Недостаточно средств: ${user.tick_balance} < ${minBalance}`);

        if (ctx.callbackQuery) {
          await ctx.answerCbQuery('Недостаточно средств');
          await ctx.editMessageText(errorMsg, Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Главное меню', 'main_menu')]
          ]));
        } else {
          await ctx.reply(errorMsg);
        }
        return;
      }

      console.log('✅ Баланс достаточный, создаем состояние для пользователя');

      this.userStates.set(userId, {
        step: 'channel_username',
        taskData: {}
      });

      const message = '📝 Создание задания\n\n' +
        'Шаг 1/4: Отправьте username канала или чата\n\n' +
        '💡 Пример: @mychannel или @mychat\n' +
        '⚠️ Убедитесь, что бот добавлен в ваш канал/чат как администратор!';

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'promote')]
      ]);

      console.log('📝 Отправляем интерфейс создания задания');

      if (ctx.callbackQuery) {
        await ctx.editMessageText(message, keyboard);
      } else {
        await ctx.reply(message, keyboard);
      }

      console.log('✅ Создание задания инициировано успешно');
    } catch (error) {
      console.error(`❌ Критическая ошибка в startTaskCreation для пользователя ${userId}:`, error);

      const errorMsg = '❌ Ош��бка создания задания. Возможно, проблемы с базой данных.\n\n' +
        'Попробуйте:\n' +
        '1. Перезапустить бота командой /start\n' +
        '2. Попробовать позже\n' +
        '3. Обратиться в поддержку';

      try {
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery('Ошибка создания задания');
          await ctx.editMessageText(errorMsg, Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Главное меню', 'main_menu')],
            [Markup.button.callback('🔄 Попробовать снова', 'create_task')]
          ]));
        } else {
          await ctx.reply(errorMsg);
        }
      } catch (sendError) {
        console.error('❌ Критическая ошибка отправки сообщения об ошибке:', sendError);
      }
    }
  }

  // Обработка шагов создания задания
  async handleTaskCreationStep(ctx, userState) {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    try {
      switch (userState.step) {
        case 'channel_username':
          await this.handleChannelUsernameStep(ctx, userState, text);
          break;
        case 'reward':
          await this.handleRewardStep(ctx, userState, text);
          break;
        case 'description':
          await this.handleDescriptionStep(ctx, userState, text);
          break;
      }
    } catch (error) {
      console.error('Ошибка создания задания:', error);
      await ctx.reply('❌ Произошла ошибка. Попробуйте снова.');
      this.userStates.delete(userId);
    }
  }

  // Обработка username канала
  async handleChannelUsernameStep(ctx, userState, text) {
    const userId = ctx.from.id;
    
    if (!text.startsWith('@')) {
      await ctx.reply('❌ Username должен начинаться с @\nПример: @mychannel');
      return;
    }

    // Проверяем, есть ли бот в канале
    try {
      const botMember = await ctx.telegram.getChatMember(text, ctx.botInfo.id);
      if (!['administrator', 'creator'].includes(botMember.status)) {
        await ctx.reply('❌ Бот должен быть администратором в канале/чате!\nДобавьте бота и повторите попытку.');
        return;
      }

      // Получаем информацию о канале
      const chat = await ctx.telegram.getChat(text);
      
      userState.taskData.channel_username = text;
      userState.taskData.channel_title = chat.title;
      userState.step = 'reward';

      const message = '📝 Создание задания\n\n' +
        'Шаг 2/4: Укажите награду за выполнение\n\n' +
        `💰 От ${config.MIN_TASK_REWARD} до ${config.MAX_TASK_REWARD} Tick коинов\n` +
        `��� Канал: ${chat.title} (${text})`;

      await ctx.reply(message);
      this.userStates.set(userId, userState);
      
    } catch (error) {
      await ctx.reply('❌ Не удалось получить доступ к каналу.\nПроверьте username и права бота.');
    }
  }

  // Обработка награды
  async handleRewardStep(ctx, userState, text) {
    const userId = ctx.from.id;
    const reward = parseInt(text);

    if (isNaN(reward) || reward < config.MIN_TASK_REWARD || reward > config.MAX_TASK_REWARD) {
      await ctx.reply(`❌ Неверная сумма награды.\nУкажите число от ${config.MIN_TASK_REWARD} до ${config.MAX_TASK_REWARD}`);
      return;
    }

    const user = await db.getUser(userId);
    if (user.tick_balance < reward) {
      await ctx.reply('❌ Недостаточ��о средств на балансе!');
      return;
    }

    userState.taskData.reward = reward;
    userState.step = 'description';

    const message = '📝 Создание задания\n\n' +
      'Шаг 3/4: Опишите задание (необязательно)\n\n' +
      '💡 Например: "Подпишитесь на наш канал с новостями"\n' +
      'Или отправьте "пропустить" чт��бы оставить стандартное описание';

    await ctx.reply(message);
    this.userStates.set(userId, userState);
  }

  // Обработка описания
  async handleDescriptionStep(ctx, userState, text) {
    const userId = ctx.from.id;
    
    if (text.toLowerCase() !== 'пропустить') {
      userState.taskData.description = text;
    }

    // Создаем задание
    const taskData = {
      creator_id: userId,
      ...userState.taskData
    };

    const task = await db.createTask(taskData);
    
    if (task) {
      // Списываем награду с баланса
      await db.updateBalance(userId, -task.reward);
      
      const message = '✅ Задание создано успешно!\n\n' +
        `📢 Канал: ${task.channel_title}\n` +
        `💰 Награда: ${task.reward} Tick коинов\n` +
        `📝 Описание: ${task.description || 'Стандартное'}\n\n` +
        'Ваше задание появилось в разделе "Заработать" ���ля других пользователей!';

      await ctx.reply(message);
    } else {
      await ctx.reply('❌ Ошибка создания задания. Попробуйте позже.');
    }

    this.userStates.delete(userId);
  }

  // Кабинет пользователя
  async showCabinet(ctx) {
    try {
      const userId = ctx.from.id;

      // Получаем статистику с повторными попытками при ошибке
      let stats = null;
      let attempts = 0;
      const maxAttempts = 3;

      while (!stats && attempts < maxAttempts) {
        try {
          attempts++;
          stats = await Promise.race([
            db.getUserStats(userId),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), 3000)
            )
          ]);

          if (stats) break;

        } catch (error) {
          console.error(`Попытка ${attempts} получения статистики:`, error);
          if (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 500)); // Пауза 500мс
          }
        }
      }

      // Используем значения по ум��лчанию если не удалось получить данные
      if (!stats) {
        stats = {
          balance: 0,
          completed_tasks: 0,
          created_tasks: 0,
          referrals: 0
        };
      }

      const message = '👤 Мой кабинет\n\n' +
        `💰 Баланс: ${stats.balance} Tick коинов\n` +
        `✅ Выполнено заданий: ${stats.completed_tasks}\n` +
        `📢 Создано заданий: ${stats.created_tasks}\n` +
        `🔗 Приглашено рефералов: ${stats.referrals}\n\n` +
        `👤 Ваш ID: ${userId}`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Обновить', 'cabinet')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
      ]);

      console.log('📊 Отправляем данные кабинета пользователю');

      if (ctx.callbackQuery) {
        // Проверяем, изменилось ли содержимое сообщения
        const currentMessage = ctx.callbackQuery.message?.text;
        if (currentMessage && currentMessage === message) {
          console.log('⚠️ Содержимое сообщения не изменилось, пропускаем обновление');
          await ctx.answerCbQuery('✅ Данные актуальны');
          return;
        }

        await ctx.editMessageText(message, keyboard);
      } else {
        await ctx.reply(message, keyboard);
      }
    } catch (error) {
      console.error('Критическая ошибка показа кабинета:', error);
      const errorKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Попробовать снова', 'cabinet')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
      ]);

      const errorMessage = '❌ Ошибка загрузки кабинета. Попробуйте снова.';

      try {
        if (ctx.callbackQuery) {
          await ctx.editMessageText(errorMessage, errorKeyboard);
        } else {
          await ctx.reply(errorMessage, errorKeyboard);
        }
      } catch (sendError) {
        console.error('Ошибка отп��авки сообщения об ошибке:', sendError);
      }
    }
  }

  // Реферальная система
  async showReferralMenu(ctx) {
    try {
      const userId = ctx.from.id;

      // Получаем данные пользователя и статистику одновременно с повторными попытками
      let user = null;
      let stats = null;
      let attempts = 0;
      const maxAttempts = 3;

      while ((!user || !stats) && attempts < maxAttempts) {
        try {
          attempts++;

          // Получаем данные параллельно
          const [userData, userStats] = await Promise.all([
            Promise.race([
              db.getUser(userId),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('User timeout')), 3000)
              )
            ]),
            Promise.race([
              db.getUserStats(userId),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Stats timeout')), 3000)
              )
            ])
          ]);

          user = userData;
          stats = userStats;

          if (user && stats) break;

        } catch (error) {
          console.error(`Попытка ${attempts} получения данных реферальной системы:`, error);
          if (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 500)); // Пауза 500мс
          }
        }
      }

      // Используем значени�� по умолчанию
      if (!user) {
        user = {
          referral_code: `temp_${userId}_${Date.now()}`
        };
      }

      if (!stats) {
        stats = {
          referrals: 0
        };
      }

      const referralLink = `https://t.me/${config.BOT_USERNAME}?start=${user.referral_code}`;
      const referralCount = stats.referrals || 0;
      const totalEarned = referralCount * config.REFERRAL_BONUS;

      const message = '🔗 Реферальная система\n\n' +
        `💰 За каждого друга: ${config.REFERRAL_BONUS} Tick коинов\n` +
        `👥 Приглашено: ${referralCount} человек\n` +
        `💎 Заработано: ${totalEarned} коинов\n\n` +
        '📤 Ваша реферальна�� ссылка:\n' +
        `\`${referralLink}\`\n\n` +
        '📢 Отправьте эту ссылку друзьям!';

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('📤 Поделиться', `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('🤖 Присоединяйся к TickPiar Bot и зарабатывай Tick коины!')}`)],
        [Markup.button.callback('🔄 Обновить', 'referral')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
      ]);

      if (ctx.callbackQuery) {
        await ctx.editMessageText(message, keyboard);
      } else {
        await ctx.reply(message, keyboard);
      }
    } catch (error) {
      console.error('Критическая ошибка показа реферальной системы:', error);
      const errorKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Попробовать снова', 'referral')],
        [Markup.button.callback('⬅️ Назад', 'main_menu')]
      ]);

      const errorMessage = '❌ Ошибка загрузки реферальной системы. Попробуйте снова.';

      try {
        if (ctx.callbackQuery) {
          await ctx.editMessageText(errorMessage, errorKeyboard);
        } else {
          await ctx.reply(errorMessage, errorKeyboard);
        }
      } catch (sendError) {
        console.error('Ошибка отправки сообщения об ошибке:', sendError);
      }
    }
  }

  // Обработка добавления бота в группу
  async handleBotAddedToGroup(ctx) {
    const chat = ctx.chat;
    const addedBy = ctx.from;

    const welcomeMessage = '🤖 Привет! Я TickPiar Bot!\n\n' +
      '🛡️ Теперь я могу контролировать доступ к сообщ��ниям в этом чате.\n' +
      '📢 Администраторы могут настроить обязательные подпис��и на спонсорские каналы.\n\n' +
      '⚙️ Для настройки обратитесь к создателю: @your_username';

    await ctx.reply(welcomeMessage);
  }

  // Проверка спонсорских подписок для новых участников
  async checkSponsorSubscriptions(ctx) {
    const chatId = ctx.chat.id;
    const newMembers = ctx.message.new_chat_members;

    const sponsorChannels = await db.getSponsorChannels(chatId);
    
    if (sponsorChannels.length === 0) return;

    for (const member of newMembers) {
      if (member.is_bot) continue;

      let hasAllSubscriptions = true;
      const missingChannels = [];

      for (const sponsor of sponsorChannels) {
        try {
          const chatMember = await ctx.telegram.getChatMember(sponsor.channel_username, member.id);
          if (!['member', 'administrator', 'creator'].includes(chatMember.status)) {
            hasAllSubscriptions = false;
            missingChannels.push(sponsor.channel_username);
          }
        } catch (error) {
          hasAllSubscriptions = false;
          missingChannels.push(sponsor.channel_username);
        }
      }

      if (!hasAllSubscriptions) {
        try {
          // Ограничиваем пользователя
          await ctx.telegram.restrictChatMember(chatId, member.id, {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false
          });

          const message = `👋 @${member.username || member.first_name}, до��ро пожаловать!\n\n` +
            '🔒 Для участия в чате подпишитесь на спонсорские каналы:\n' +
            missingChannels.map(ch => `���� ${ch}`).join('\n') + '\n\n' +
            '✅ После подписки ваши ограничения будут сняты автоматически.';

          await ctx.reply(message);
        } catch (error) {
          console.error('Ошибка ограничения пользователя:', error);
        }
      }
    }
  }

  // Проверка возможности отправки сообщений
  async checkUserCanSendMessage(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const sponsorChannels = await db.getSponsorChannels(chatId);

    if (sponsorChannels.length === 0) return;

    let hasAllSubscriptions = true;
    
    for (const sponsor of sponsorChannels) {
      try {
        const chatMember = await ctx.telegram.getChatMember(sponsor.channel_username, userId);
        if (!['member', 'administrator', 'creator'].includes(chatMember.status)) {
          hasAllSubscriptions = false;
          break;
        }
      } catch (error) {
        hasAllSubscriptions = false;
        break;
      }
    }

    if (!hasAllSubscriptions) {
      try {
        await ctx.deleteMessage();
        
        const warning = await ctx.reply(
          `⚠️ @${ctx.from.username || ctx.from.first_name}, подпишитесь на спонсорские каналы для участия в чате!`,
          { reply_to_message_id: ctx.message.message_id }
        );

        // Удаляем предупреждение через 10 секунд
        setTimeout(() => {
          ctx.telegram.deleteMessage(chatId, warning.message_id).catch(() => {});
        }, 10000);
      } catch (error) {
        console.error('Ошибка удаления сообщения:', error);
      }
    }
  }

  stop() {
    this.bot.stop('SIGINT');
    this.bot.stop('SIGTERM');
  }
}

// Запуск бота
const bot = new TickPiarBot();

// Graceful shutdown
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

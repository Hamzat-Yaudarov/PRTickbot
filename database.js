const { Pool } = require('pg');
const config = require('./config');

class Database {
  constructor() {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      },
      // Оптимизация пула соединений
      max: 20, // максимум соединений
      min: 2,  // минимум соединений
      idleTimeoutMillis: 30000, // таймаут простоя
      connectionTimeoutMillis: 10000, // таймаут подключения
      acquireTimeoutMillis: 5000 // таймаут получения соединения
    });
  }

  async init() {
    try {
      console.log('🔄 Начинаем инициализацию базы данных...');
      
      // Создаем таблицы последовательно для избежания проблем с FK
      console.log('📝 Создаем таблицу пользователей...');
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          user_id BIGINT PRIMARY KEY,
          username VARCHAR(255),
          first_name VARCHAR(255),
          last_name VARCHAR(255),
          tick_balance INTEGER DEFAULT 0,
          referral_code VARCHAR(50) UNIQUE,
          referred_by BIGINT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          is_banned BOOLEAN DEFAULT FALSE
        )
      `);
      console.log('✅ Таблица users создана');

      // Ждем немного для уверенности
      await new Promise(resolve => setTimeout(resolve, 100));

      console.log('📝 Создаем таблицу заданий...');
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          task_id SERIAL PRIMARY KEY,
          creator_id BIGINT NOT NULL,
          channel_username VARCHAR(255) NOT NULL,
          channel_title VARCHAR(255),
          reward INTEGER NOT NULL CHECK (reward >= 15 AND reward <= 50),
          description TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          completed_count INTEGER DEFAULT 0,
          max_completions INTEGER DEFAULT 1000,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Таблица tasks создана');

      // Прове��яем и добавляем foreign key constraint отдельно
      console.log('📝 Проверяем и добавляем foreign key для tasks...');
      try {
        // Сначала удаляем существующий constraint если есть
        await this.pool.query(`
          ALTER TABLE tasks
          DROP CONSTRAINT IF EXISTS fk_tasks_creator_id
        `);

        // Проверяем, что колонка creator_id существует и нужного типа
        const columnCheck = await this.pool.query(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'creator_id'
        `);

        if (columnCheck.rows.length === 0) {
          console.log('⚠️ Колонка creator_id не найдена, создаем...');
          await this.pool.query(`
            ALTER TABLE tasks
            ADD COLUMN creator_id BIGINT NOT NULL DEFAULT 0
          `);
        }

        // Добавляем foreign key constraint
        await this.pool.query(`
          ALTER TABLE tasks
          ADD CONSTRAINT fk_tasks_creator_id
          FOREIGN KEY (creator_id) REFERENCES users(user_id)
        `);
      } catch (fkError) {
        console.error('⚠️ Ошибка добавления foreign key для tasks:', fkError.message);
        // Продолжаем без foreign key constraint
      }
      console.log('✅ Foreign key для tasks добавлен');

      console.log('📝 Создаем таблицу выполнений заданий...');
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS task_completions (
          completion_id SERIAL PRIMARY KEY,
          task_id INTEGER NOT NULL,
          user_id BIGINT NOT NULL,
          completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          is_verified BOOLEAN DEFAULT FALSE,
          UNIQUE(task_id, user_id)
        )
      `);
      console.log('✅ Таблица task_completions создана');

      // Добавляем foreign key constraints для task_completions
      console.log('📝 Добавляем foreign keys для task_completions...');
      try {
        await this.pool.query(`
          ALTER TABLE task_completions
          DROP CONSTRAINT IF EXISTS fk_task_completions_task_id
        `);
        await this.pool.query(`
          ALTER TABLE task_completions
          DROP CONSTRAINT IF EXISTS fk_task_completions_user_id
        `);
        await this.pool.query(`
          ALTER TABLE task_completions
          ADD CONSTRAINT fk_task_completions_task_id
          FOREIGN KEY (task_id) REFERENCES tasks(task_id)
        `);
        await this.pool.query(`
          ALTER TABLE task_completions
          ADD CONSTRAINT fk_task_completions_user_id
          FOREIGN KEY (user_id) REFERENCES users(user_id)
        `);
      } catch (fkError) {
        console.error('⚠️ Ошибка добавления foreign keys для task_completions:', fkError.message);
      }
      console.log('✅ Foreign keys для task_completions добавлены');

      console.log('📝 Создаем таблицу спонсорских каналов...');
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS sponsor_channels (
          sponsor_id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          channel_username VARCHAR(255) NOT NULL,
          added_by BIGINT NOT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Foreign key для sponsor_channels
      console.log('📝 Добавляем foreign key для sponsor_channels...');
      try {
        await this.pool.query(`
          ALTER TABLE sponsor_channels
          DROP CONSTRAINT IF EXISTS fk_sponsor_channels_added_by
        `);
        await this.pool.query(`
          ALTER TABLE sponsor_channels
          ADD CONSTRAINT fk_sponsor_channels_added_by
          FOREIGN KEY (added_by) REFERENCES users(user_id)
        `);
      } catch (fkError) {
        console.error('⚠️ Ошибка добавления foreign key для sponsor_channels:', fkError.message);
      }
      console.log('✅ Foreign key для sponsor_channels добавлен');

      console.log('📝 Создаем таблицу рефералов...');
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS referrals (
          referral_id SERIAL PRIMARY KEY,
          referrer_id BIGINT NOT NULL,
          referred_id BIGINT NOT NULL,
          bonus_paid BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Foreign keys для referrals
      console.log('📝 Добавляем foreign keys для referrals...');
      try {
        await this.pool.query(`
          ALTER TABLE referrals
          DROP CONSTRAINT IF EXISTS fk_referrals_referrer_id
        `);
        await this.pool.query(`
          ALTER TABLE referrals
          DROP CONSTRAINT IF EXISTS fk_referrals_referred_id
        `);
        await this.pool.query(`
          ALTER TABLE referrals
          ADD CONSTRAINT fk_referrals_referrer_id
          FOREIGN KEY (referrer_id) REFERENCES users(user_id)
        `);
        await this.pool.query(`
          ALTER TABLE referrals
          ADD CONSTRAINT fk_referrals_referred_id
          FOREIGN KEY (referred_id) REFERENCES users(user_id)
        `);
      } catch (fkError) {
        console.error('⚠️ Ошибка добавления foreign keys для referrals:', fkError.message);
      }
      console.log('✅ Foreign keys для referrals добавлены');

      // Создаем индексы для оптимизации запросов
      console.log('📝 Создаем индексы...');

      const indexes = [
        { name: 'idx_users_referral_code', query: 'CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)' },
        { name: 'idx_tasks_active', query: 'CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_active, reward, created_at)' },
        { name: 'idx_tasks_creator', query: 'CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_id)' },
        { name: 'idx_task_completions_user', query: 'CREATE INDEX IF NOT EXISTS idx_task_completions_user ON task_completions(user_id)' },
        { name: 'idx_task_completions_task', query: 'CREATE INDEX IF NOT EXISTS idx_task_completions_task ON task_completions(task_id)' },
        { name: 'idx_task_completions_unique', query: 'CREATE INDEX IF NOT EXISTS idx_task_completions_unique ON task_completions(task_id, user_id)' },
        { name: 'idx_referrals_referrer', query: 'CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)' },
        { name: 'idx_sponsor_channels_chat', query: 'CREATE INDEX IF NOT EXISTS idx_sponsor_channels_chat ON sponsor_channels(chat_id, is_active)' }
      ];

      for (const index of indexes) {
        try {
          await this.pool.query(index.query);
          console.log(`✅ Индекс ${index.name} создан`);
        } catch (indexError) {
          console.error(`⚠️ Ошибка создания индекса ${index.name}:`, indexError.message);
        }
      }

      // Миграция схемы базы данных
      console.log('🔄 Проверяем и обновляем схему базы данных...');
      await this.migrateSchema();

      console.log('✅ База данных полностью инициализирована!');
    } catch (error) {
      console.error('❌ Ошибка инициализации базы данных:', error);
      throw error; // Пробрасываем ошибку для обработки выше
    }
  }

  async migrateSchema() {
    try {
      console.log('🔄 Начинаем миграцию схемы...');

      // Миграция таблицы users
      console.log('📝 Миграция таблицы users...');

      // Добавляем недостающие колонки в users
      const userMigrations = [
        { column: 'user_id', sql: 'ALTER TABLE users ADD COLUMN user_id BIGINT' },
        { column: 'tick_balance', sql: 'ALTER TABLE users ADD COLUMN tick_balance INTEGER DEFAULT 0' },
        { column: 'referral_code', sql: 'ALTER TABLE users ADD COLUMN referral_code VARCHAR(50) UNIQUE' },
        { column: 'last_name', sql: 'ALTER TABLE users ADD COLUMN last_name VARCHAR(255)' },
        { column: 'is_banned', sql: 'ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT FALSE' }
      ];

      for (const migration of userMigrations) {
        try {
          // Проверяем, существует ли колонка
          const columnExists = await this.pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = $1
          `, [migration.column]);

          if (columnExists.rows.length === 0) {
            await this.pool.query(migration.sql);
            console.log(`✅ Добавлена колонка users.${migration.column}`);
          }
        } catch (migrationError) {
          console.error(`⚠️ Ошибка миграции users.${migration.column}:`, migrationError.message);
        }
      }

      // Копируем данные id -> user_id если user_id пустой
      try {
        await this.pool.query(`
          UPDATE users SET user_id = id WHERE user_id IS NULL OR user_id = 0
        `);

        // Копируем balance -> tick_balance
        await this.pool.query(`
          UPDATE users SET tick_balance = COALESCE(balance, 0) WHERE tick_balance = 0
        `);

        console.log('✅ Данные users мигрированы');
      } catch (dataError) {
        console.error('⚠️ Ошибка миграции данных users:', dataError.message);
      }

      // Миграция таблицы tasks
      console.log('📝 Миграция таблицы tasks...');

      const taskMigrations = [
        { column: 'task_id', sql: 'ALTER TABLE tasks ADD COLUMN task_id SERIAL' },
        { column: 'channel_title', sql: 'ALTER TABLE tasks ADD COLUMN channel_title VARCHAR(255)' },
        { column: 'description', sql: 'ALTER TABLE tasks ADD COLUMN description TEXT' },
        { column: 'max_completions', sql: 'ALTER TABLE tasks ADD COLUMN max_completions INTEGER DEFAULT 1000' }
      ];

      for (const migration of taskMigrations) {
        try {
          const columnExists = await this.pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'tasks' AND column_name = $1
          `, [migration.column]);

          if (columnExists.rows.length === 0) {
            await this.pool.query(migration.sql);
            console.log(`✅ Добавлена колонка tasks.${migration.column}`);
          }
        } catch (migrationError) {
          console.error(`⚠️ Ошибка миграции tasks.${migration.column}:`, migrationError.message);
        }
      }

      // Копируем данные id -> task_id, owner_id -> creator_id
      try {
        await this.pool.query(`
          UPDATE tasks SET task_id = id WHERE task_id IS NULL OR task_id = 0
        `);

        // Если creator_id пустой, копируем из owner_id
        await this.pool.query(`
          UPDATE tasks SET creator_id = COALESCE(owner_id, creator_id) WHERE creator_id IS NULL OR creator_id = 0
        `);

        console.log('✅ Данные tasks мигрированы');
      } catch (dataError) {
        console.error('⚠️ Ошибка миграции данных tasks:', dataError.message);
      }

      console.log('✅ Миграция схемы завершена');
    } catch (error) {
      console.error('❌ Ошибка миграции схемы:', error);
    }
  }

  // Пользователи
  async createUser(userData) {
    const { user_id, username, first_name, last_name, referral_code } = userData;
    try {
      const result = await this.pool.query(
        `INSERT INTO users (user_id, username, first_name, last_name, referral_code)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET
           username = EXCLUDED.username,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name
         RETURNING *`,
        [user_id, username, first_name, last_name, referral_code]
      );
      return result.rows[0] || await this.getUser(user_id);
    } catch (error) {
      console.error('Ошибка создания пользователя:', error);
      // Попытка получить существующего пользователя
      try {
        return await this.getUser(user_id);
      } catch (getError) {
        console.error('Ошибка получения пользователя после неудачного создания:', getError);
        return null;
      }
    }
  }

  async getUser(user_id) {
    try {
      const result = await Promise.race([
        this.pool.query('SELECT * FROM users WHERE user_id = $1', [user_id]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Query timeout')), 5000)
        )
      ]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Ошибка получения пользователя:', error);
      return null;
    }
  }

  async updateBalance(user_id, amount) {
    try {
      const result = await this.pool.query(
        'UPDATE users SET tick_balance = tick_balance + $1 WHERE user_id = $2 RETURNING tick_balance',
        [amount, user_id]
      );
      return result.rows[0]?.tick_balance;
    } catch (error) {
      console.error('Ошибка обновления баланса:', error);
      return null;
    }
  }

  // Задания
  async createTask(taskData) {
    const { creator_id, channel_username, channel_title, reward, description } = taskData;
    try {
      const result = await this.pool.query(
        `INSERT INTO tasks (creator_id, channel_username, channel_title, reward, description) 
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [creator_id, channel_username, channel_title, reward, description]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Ошибка создания задания:', error);
      return null;
    }
  }

  async getAvailableTasks(user_id, limit = 10) {
    try {
      const result = await this.pool.query(`
        SELECT t.* FROM tasks t
        WHERE t.is_active = TRUE
        AND t.creator_id != $1
        AND NOT EXISTS (
          SELECT 1 FROM task_completions tc
          WHERE tc.task_id = t.task_id AND tc.user_id = $1
        )
        AND t.completed_count < t.max_completions
        ORDER BY t.reward DESC, t.created_at DESC
        LIMIT $2
      `, [user_id, limit]);
      return result.rows;
    } catch (error) {
      console.error('Ошибка получения заданий:', error);
      return [];
    }
  }

  async completeTask(user_id, task_id) {
    try {
      // Проверяем задание
      const taskResult = await this.pool.query('SELECT * FROM tasks WHERE task_id = $1 AND is_active = TRUE', [task_id]);
      if (taskResult.rows.length === 0) return null;

      const task = taskResult.rows[0];

      // Добавляем выполнение
      await this.pool.query(
        'INSERT INTO task_completions (task_id, user_id, is_verified) VALUES ($1, $2, $3)',
        [task_id, user_id, true]
      );

      // Обновляем баланс пользователя
      await this.updateBalance(user_id, task.reward);

      // Обновляем счетчик выполнений
      await this.pool.query(
        'UPDATE tasks SET completed_count = completed_count + 1 WHERE task_id = $1',
        [task_id]
      );

      return task;
    } catch (error) {
      console.error('Ошибка выполнения задания:', error);
      return null;
    }
  }

  // Рефералы
  async processReferral(referrer_id, referred_id) {
    try {
      // Проверяем, не был ли уже обработан этот реферал
      const existingReferral = await this.pool.query(
        'SELECT * FROM referrals WHERE referrer_id = $1 AND referred_id = $2',
        [referrer_id, referred_id]
      );

      if (existingReferral.rows.length > 0) return false;

      // Добавляем реферала
      await this.pool.query(
        'INSERT INTO referrals (referrer_id, referred_id, bonus_paid) VALUES ($1, $2, $3)',
        [referrer_id, referred_id, true]
      );

      // Начисляем бонус
      await this.updateBalance(referrer_id, config.REFERRAL_BONUS);

      return true;
    } catch (error) {
      console.error('Ошибка обработки реферала:', error);
      return false;
    }
  }

  // Спонсорские каналы
  async addSponsorChannel(chat_id, channel_username, added_by) {
    try {
      const result = await this.pool.query(
        'INSERT INTO sponsor_channels (chat_id, channel_username, added_by) VALUES ($1, $2, $3) RETURNING *',
        [chat_id, channel_username, added_by]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Ошибка добавления спонсорского канала:', error);
      return null;
    }
  }

  async getSponsorChannels(chat_id) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM sponsor_channels WHERE chat_id = $1 AND is_active = TRUE',
        [chat_id]
      );
      return result.rows;
    } catch (error) {
      console.error('Ошибка получения спонсорских каналов:', error);
      return [];
    }
  }

  async getUserStats(user_id) {
    try {
      // Объединяем все запросы в один для ускорения
      const result = await this.pool.query(`
        SELECT
          u.tick_balance,
          (
            SELECT COUNT(*)
            FROM task_completions tc
            WHERE tc.user_id = u.user_id
          ) as completed_tasks,
          (
            SELECT COUNT(*)
            FROM tasks t
            WHERE t.creator_id = u.user_id
          ) as created_tasks,
          (
            SELECT COUNT(*)
            FROM referrals r
            WHERE r.referrer_id = u.user_id
          ) as referrals
        FROM users u
        WHERE u.user_id = $1
      `, [user_id]);

      if (result.rows.length === 0) {
        return {
          balance: 0,
          completed_tasks: 0,
          created_tasks: 0,
          referrals: 0
        };
      }

      const row = result.rows[0];
      return {
        balance: parseInt(row.tick_balance) || 0,
        completed_tasks: parseInt(row.completed_tasks) || 0,
        created_tasks: parseInt(row.created_tasks) || 0,
        referrals: parseInt(row.referrals) || 0
      };
    } catch (error) {
      console.error('Ошибка получения статистики:', error);
      return {
        balance: 0,
        completed_tasks: 0,
        created_tasks: 0,
        referrals: 0
      };
    }
  }
}

module.exports = new Database();

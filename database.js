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
      connectionTimeoutMillis: 10000, // таймаут подключ��ния
      acquireTimeoutMillis: 5000 // таймаут получения соединения
    });
  }

  async init() {
    try {
      // Создаем таблицу пользователей
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

      // Создаем таблицу заданий
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          task_id SERIAL PRIMARY KEY,
          creator_id BIGINT REFERENCES users(user_id),
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

      // Создаем таблицу выполнений з��даний
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS task_completions (
          completion_id SERIAL PRIMARY KEY,
          task_id INTEGER REFERENCES tasks(task_id),
          user_id BIGINT REFERENCES users(user_id),
          completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          is_verified BOOLEAN DEFAULT FALSE,
          UNIQUE(task_id, user_id)
        )
      `);

      // Создаем таблицу спонсорских каналов для чатов
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS sponsor_channels (
          sponsor_id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          channel_username VARCHAR(255) NOT NULL,
          added_by BIGINT REFERENCES users(user_id),
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Создаем таблицу рефералов
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS referrals (
          referral_id SERIAL PRIMARY KEY,
          referrer_id BIGINT REFERENCES users(user_id),
          referred_id BIGINT REFERENCES users(user_id),
          bonus_paid BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Создаем индексы для оптимизации запросов
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_active, reward, created_at)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_id)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_task_completions_user ON task_completions(user_id)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_task_completions_task ON task_completions(task_id)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_task_completions_unique ON task_completions(task_id, user_id)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_sponsor_channels_chat ON sponsor_channels(chat_id, is_active)');

      console.log('✅ База данных инициализирована с индексами');
    } catch (error) {
      console.error('❌ Ошибка инициализации базы данных:', error);
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
      console.error('Ошибка ��оздания пользователя:', error);
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

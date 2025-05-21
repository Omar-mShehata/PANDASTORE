require('dotenv').config();
const { Client } = require('pg');
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();

// اتصال PostgreSQL للاحالات
const pgClient = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pgClient.connect()
  .then(() => console.log("✅ تم الاتصال بقاعدة بيانات PostgreSQL بنجاح"))
  .catch(err => console.error('❌ فشل الاتصال بقاعدة PostgreSQL:', err));

// اتصال MongoDB للأوامر
const mongoURI = process.env.MONGO_URI;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_IDS = [process.env.ADMIN_ID, process.env.SECOND_ADMIN_ID].filter(Boolean);
const CHANNEL_ID = process.env.CHANNEL_ID;

mongoose.connect(mongoURI)
  .then(() => console.log("✅ تم الاتصال بقاعدة بيانات MongoDB Atlas بنجاح"))
  .catch((error) => console.error("❌ فشل الاتصال بقاعدة البيانات:", error));

// المخططات والنماذج
const orderSchema = new mongoose.Schema({
  username: String,
  stars: Number,
  amountTon: String,
  amountUsd: String,
  type: { type: String, enum: ['stars', 'premium'], default: 'stars' },
  premiumMonths: Number,
  createdAt: { type: Date, default: Date.now },
  completed: { type: Boolean, default: false },
});
const Order = mongoose.model('Order', orderSchema);

// التأكد من وجود جدول الاحالات مع جميع الأعمدة المطلوبة
(async () => {
  try {
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        user_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        phone_number VARCHAR(20),
        referral_code VARCHAR(10) UNIQUE,
        invited_by VARCHAR(10),
        stars INTEGER DEFAULT 0,
        verified BOOLEAN DEFAULT false,
        verification_emojis VARCHAR(100),
        verification_message_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ تم التأكد من وجود جدول referrals مع جميع الأعمدة");
  } catch (err) {
    console.error("❌ خطأ في إنشاء/تعديل جدول referrals:", err);
  }
})();

// وظائف مساعدة
function isWorkingHours() {
  const now = new Date();
  // تحويل الوقت إلى توقيت القاهرة
  const options = { 
    timeZone: 'Africa/Cairo',
    hour: 'numeric',
    hour12: false
  };
  const hour = parseInt(new Intl.DateTimeFormat('en-GB', options).format(now));
  return hour >= 8 && hour < 24; // من 8 صباحًا حتى 12 منتصف الليل
}

function generateRandomEmojis(count) {
  const emojis = ['😀', '😎', '🐼', '🚀', '⭐', '💰', '🎯', '🦁', '🐶', '🍎', '🍕', '⚽'];
  const selected = [];
  while (selected.length < count) {
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    if (!selected.includes(randomEmoji)) {
      selected.push(randomEmoji);
    }
  }
  return selected;
}

async function isUserSubscribed(chatId) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getChatMember`, {
      params: {
        chat_id: `@${CHANNEL_ID.replace('@', '')}`,
        user_id: chatId
      }
    });
    return ['member', 'administrator', 'creator'].includes(response.data.result.status);
  } catch (error) {
    console.error("Error checking subscription:", error);
    return false;
  }
}

async function generateReferralCode(userId) {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  try {
    await pgClient.query('UPDATE referrals SET referral_code = $1 WHERE user_id = $2', [code, userId]);
    return code;
  } catch (err) {
    console.error("Error generating referral code:", err);
    return null;
  }
}

async function addStarsToReferrer(userId, starsToAdd) {
  try {
    const referrerResult = await pgClient.query(
      'SELECT invited_by FROM referrals WHERE user_id = $1',
      [userId]
    );
    
    if (referrerResult.rows.length > 0 && referrerResult.rows[0].invited_by) {
      const referralCode = referrerResult.rows[0].invited_by;
      await pgClient.query(
        'UPDATE referrals SET stars = stars + $1 WHERE referral_code = $2 AND verified = true',
        [starsToAdd, referralCode]
      );
    }
  } catch (err) {
    console.error("Error adding stars to referrer:", err);
  }
}

// Middleware
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static('public'));

// ==============================================
// نقاط النهاية
// ==============================================

app.post('/order', async (req, res) => {
  try {
    const { username, stars, amountTon, amountUsd, createdAt } = req.body;
    const orderCreatedAt = createdAt || new Date().toISOString();

    const formattedDate = new Date(orderCreatedAt).toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true, timeZone: 'Africa/Cairo',
    });

    const newOrder = new Order({ 
      username, 
      stars, 
      amountTon, 
      amountUsd, 
      type: 'stars',
      createdAt: orderCreatedAt 
    });
    await newOrder.save();

    const fragmentLink = "https://fragment.com/stars";

    for (let adminId of ADMIN_IDS) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: adminId,
        text: `New Order 🛒\n👤 Username: @${username}\n⭐️ Stars: ${stars}\n💰 TON: ${amountTon} TON\n💵 USDT: ${amountUsd} USDT\n📅 Order Date: ${formattedDate}`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔗 تنفيذ الطلب للمستخدم", web_app: { url: fragmentLink } }
            ],
            [
              { text: "🛩 تحديث الطلب فى قاعده البيانات", callback_data: `complete_${newOrder._id}` }
            ]
          ]
        }
      });
    }

    res.status(200).send('✅ تم استلام طلبك بنجاح!');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حدث خطأ أثناء معالجة الطلب');
  }
});

app.post('/premium', async (req, res) => {
  try {
    const { username, months, amountTon, amountUsd } = req.body;
    const orderCreatedAt = new Date().toISOString();

    const formattedDate = new Date(orderCreatedAt).toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true, timeZone: 'Africa/Cairo',
    });

    const newOrder = new Order({ 
      username, 
      amountTon, 
      amountUsd, 
      type: 'premium',
      premiumMonths: months,
      createdAt: orderCreatedAt 
    });
    await newOrder.save();

    for (let adminId of ADMIN_IDS) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: adminId,
        text: `New Premium Order 🛒\n👤 Username: @${username}\n📅 Months: ${months}\n💰 TON: ${amountTon} TON\n💵 USDT: ${amountUsd} USDT\n📅 Order Date: ${formattedDate}`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🛩 تحديث الطلب فى قاعده البيانات", callback_data: `complete_${newOrder._id}` }
            ]
          ]
        }
      });
    }

    res.status(200).send('✅ تم استلام طلبك بنجاح!');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حدث خطأ أثناء معالجة الطلب');
  }
});

app.get('/admin', async (req, res) => {
  try {
    const orders = await Order.find();
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حدث خطأ أثناء جلب البيانات');
  }
});

app.get('/admin/stars', async (req, res) => {
  try {
    const orders = await Order.find({ type: 'stars' });
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حدث خطأ أثناء جلب بيانات النجوم');
  }
});

app.get('/admin/premium', async (req, res) => {
  try {
    const orders = await Order.find({ type: 'premium' });
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حدث خطأ أثناء جلب بيانات البريميوم');
  }
});

app.post('/complete-order/:id', async (req, res) => {
  try {
    const orderId = req.params.id;
    await Order.findByIdAndUpdate(orderId, { completed: true });
    res.status(200).send('✅ تم تحديث حالة الطلب');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حدث خطأ أثناء تحديث الطلب');
  }
});

// باقي كود ويب هوك التيليجرام كما هو...
app.post('/telegramWebhook', async (req, res) => {
  const body = req.body;

  // 1. التحقق من المستخدمين الروس
  if (body.message?.from?.language_code === 'ru') {
    const chatId = body.message.chat.id;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: "⛔ عذرًا، لا نقدم الخدمة للمستخدمين من روسيا."
    });
    return res.sendStatus(200);
  }

  // 2. التحقق من الاشتراك في القناة
  if (body.callback_query?.data === "check_subscription") {
    const chatId = body.callback_query.from.id;
    const isSubscribed = await isUserSubscribed(chatId);
    
    if (isSubscribed) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: "📱 يرجى مشاركة رقم هاتفك للمتابعة:",
        reply_markup: {
          keyboard: [[{ text: "مشاركة رقم الهاتف", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: "❌ لم تشترك في القناة بعد. يرجى الاشتراك أولاً ثم اضغط على ✅ لقد اشتركت",
        reply_markup: {
          inline_keyboard: [
            [{ text: "انضم إلى القناة", url: `https://t.me/${CHANNEL_ID.replace('@', '')}` }],
            [{ text: "✅ لقد اشتركت", callback_data: "check_subscription" }]
          ]
        }
      });
    }
    return res.sendStatus(200);
  }

  if (body.message?.text === "/start" || body.message?.text === "/shop" || body.message?.text === "/invite") {
    const chatId = body.message.chat.id;
    const isSubscribed = await isUserSubscribed(chatId);
    if (!isSubscribed) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: "📢 يرجى الاشتراك في قناتنا أولاً لتتمكن من استخدام البوت:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "انضم إلى القناة", url: `https://t.me/${CHANNEL_ID.replace('@', '')}` }],
            [{ text: "✅ لقد اشتركت", callback_data: "check_subscription" }]
          ]
        }
      });
      return res.sendStatus(200);
    }
  }

  // 3. التحقق من رقم الهاتف والايموجي
  if (body.message?.text === "/start") {
    const chatId = body.message.chat.id;
    const userResult = await pgClient.query('SELECT * FROM referrals WHERE user_id = $1', [chatId]);
    
    if (userResult.rows.length === 0) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: "📱 يرجى مشاركة رقم هاتفك للمتابعة:",
        reply_markup: {
          keyboard: [[{ text: "مشاركة رقم الهاتف", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
      return res.sendStatus(200);
    } else if (!userResult.rows[0].verified) {
      if (!userResult.rows[0].verification_emojis) {
        const emojis = generateRandomEmojis(9);
        const targetEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        
        await pgClient.query('UPDATE referrals SET verification_emojis = $1 WHERE user_id = $2', 
          [emojis.join(','), chatId]);
        
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: `🔐 للتحقق، يرجى الضغط على الايموجي: ${targetEmoji}`
        });
        
        const message = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: "اختر الايموجي المطلوب:",
          reply_markup: {
            inline_keyboard: [
              emojis.slice(0, 3).map(e => ({ text: e, callback_data: `verify_${e}_${targetEmoji}` })),
              emojis.slice(3, 6).map(e => ({ text: e, callback_data: `verify_${e}_${targetEmoji}` })),
              emojis.slice(6, 9).map(e => ({ text: e, callback_data: `verify_${e}_${targetEmoji}` }))
            ]
          }
        });
        
        await pgClient.query('UPDATE referrals SET verification_message_id = $1 WHERE user_id = $2', 
          [message.data.result.message_id, chatId]);
      }
      return res.sendStatus(200);
    }
  }

  // 4. معالجة التحقق بالايموجي
  if (body.callback_query?.data.startsWith('verify_')) {
    const [_, selectedEmoji, targetEmoji] = body.callback_query.data.split('_');
    const userId = body.callback_query.from.id;
    const messageId = body.callback_query.message.message_id;
    
    if (selectedEmoji === targetEmoji) {
      await pgClient.query('UPDATE referrals SET verified = true, verification_emojis = NULL WHERE user_id = $1', [userId]);
      
      // إضافة النجوم للمدعو
      await pgClient.query('UPDATE referrals SET stars = stars + 1 WHERE user_id = $1', [userId]);
      
      // إضافة النجوم للمدعِي إذا كان موجوداً
      await addStarsToReferrer(userId, 1);
      
      try {
        const userResult = await pgClient.query('SELECT verification_message_id FROM referrals WHERE user_id = $1', [userId]);
        const verificationMessageId = userResult.rows[0]?.verification_message_id;
        
        if (verificationMessageId) {
          try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
              chat_id: userId,
              message_id: verificationMessageId
            });
          } catch (deleteErr) {
            if (deleteErr.response?.data?.description !== 'Bad Request: message to delete not found') {
              console.error("Error deleting verification message:", deleteErr);
            }
          }
        }
        
        try {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
            chat_id: userId,
            message_id: messageId
          });
        } catch (deleteErr) {
          if (deleteErr.response?.data?.description !== 'Bad Request: message to delete not found') {
            console.error("Error deleting emoji message:", deleteErr);
          }
        }
      } catch (err) {
        console.error("Error during verification cleanup:", err);
      }
      
      const welcomeMessage = "✅ تم التحقق بنجاح! مرحبًا بك في Panda Store 🐼\nيمكنك شراء نجوم تليجرام من موقعنا الرسمى🚀\nارسل امر /invite لبدا الربح من البوت";
      const replyMarkup = {
        inline_keyboard: [
          [{ text: "للمشاهدة اضغط هنا 🚀", callback_data: "watch_warning" }],
          [{ text: "للشراء والطلب اضغط هنا 🚀", callback_data: "check_order_time" }],
          [{ text: "انضمام الى قناه الاثباتات", url: "https://t.me/Buy_StarsTG" }]
        ]
      };

      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: welcomeMessage,
        reply_markup: replyMarkup
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "❌ الايموجي الذي اخترته غير صحيح. يرجى المحاولة مرة أخرى."
      });
    }
    return res.sendStatus(200);
  }

  // 5. معالجة رقم الهاتف
  if (body.message?.contact) {
    const phone = body.message.contact.phone_number;
    const userId = body.message.from.id;
    const username = body.message.from.username || 'غير معروف';
    
    if (phone.startsWith('+7')) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "⛔ عذرًا، لا نقدم الخدمة للمستخدمين من روسيا."
      });
      return res.sendStatus(200);
    }
    
    try {
      const userExists = await pgClient.query('SELECT * FROM referrals WHERE user_id = $1', [userId]);
      
      if (userExists.rows.length > 0) {
        await pgClient.query(
          'UPDATE referrals SET phone_number = $1, username = $2 WHERE user_id = $3',
          [phone, username, userId]
        );
      } else {
        await pgClient.query(
          'INSERT INTO referrals (user_id, username, phone_number, verified) VALUES ($1, $2, $3, $4)',
          [userId, username, phone, false]
        );
      }
      
      const emojis = generateRandomEmojis(9);
      const targetEmoji = emojis[Math.floor(Math.random() * emojis.length)];
      
      await pgClient.query('UPDATE referrals SET verification_emojis = $1 WHERE user_id = $2', 
        [emojis.join(','), userId]);
      
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: `🔐 شكرًا لمشاركة رقم هاتفك. للتحقق، يرجى الضغط على الايموجي: ${targetEmoji}`
      });
      
      const message = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "اختر الايموجي المطلوب:",
        reply_markup: {
          inline_keyboard: [
            emojis.slice(0, 3).map(e => ({ text: e, callback_data: `verify_${e}_${targetEmoji}` })),
            emojis.slice(3, 6).map(e => ({ text: e, callback_data: `verify_${e}_${targetEmoji}` })),
            emojis.slice(6, 9).map(e => ({ text: e, callback_data: `verify_${e}_${targetEmoji}` }))
          ]
        }
      });
      
      await pgClient.query('UPDATE referrals SET verification_message_id = $1 WHERE user_id = $2', 
        [message.data.result.message_id, userId]);
    } catch (err) {
      console.error("Error saving phone number:", err);
    }
    return res.sendStatus(200);
  }

  // 6. معالجة الأمر /invite
  if (body.message?.text === "/invite") {
    const userId = body.message.from.id;
    const userResult = await pgClient.query('SELECT * FROM referrals WHERE user_id = $1', [userId]);
    
    if (userResult.rows.length === 0) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "❗ يرجى إكمال عملية التسجيل أولاً عن طريق إرسال /start"
      });
      return res.sendStatus(200);
    }
    
    const referralCode = userResult.rows[0].referral_code || await generateReferralCode(userId);
    const referralLink = `https://t.me/PandaStores_bot?start=${referralCode}`;
    
    const statsResult = await pgClient.query(
      'SELECT COUNT(*) FROM referrals WHERE invited_by = $1 AND verified = true', 
      [referralCode]
    );
    const referralCount = statsResult.rows[0].count;
    
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: userId,
      text: `📣 رابط الدعوة الخاص بك:\n${referralLink}\n\n🔢 عدد الأحالات: ${referralCount}\n⭐ النجوم المتراكمة: ${userResult.rows[0].stars}`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "مشاركة الرابط", url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=انضم%20إلى%20بوت%20شراء%20نجوم%20تليجرام!` }]
        ]
      }
    });
    return res.sendStatus(200);
  }

  // 7. معالجة الأمر /shop
  if (body.message?.text === "/shop") {
    const userId = body.message.from.id;
    const userResult = await pgClient.query('SELECT stars FROM referrals WHERE user_id = $1', [userId]);
    
    if (userResult.rows.length === 0) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "❗ يرجى إكمال عملية التسجيل أولاً عن طريق إرسال /start"
      });
      return res.sendStatus(200);
    }
    
    const userStars = userResult.rows[0].stars;
    
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: userId,
      text: `🛒 متجر النجوم\n\n⭐ النجوم المتاحة: ${userStars}`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "15 نجمة", callback_data: "buy_15" }],
          [{ text: "25 نجمة", callback_data: "buy_25" }],
          [{ text: "50 نجمة", callback_data: "buy_50" }],
          [{ text: "إدخال عدد مخصص", callback_data: "custom_amount" }]
        ]
      }
    });
    return res.sendStatus(200);
  }

  // 8. معالجة شراء النجوم
  if (body.callback_query?.data.startsWith('buy_')) {
    const action = body.callback_query.data;
    const userId = body.callback_query.from.id;
    const username = body.callback_query.from.username;
    
    if (action === "custom_amount") {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "📝 يرجى إدخال عدد النجوم التي ترغب في شرائها (الحد الأدنى 50 نجمة):",
        reply_markup: { force_reply: true }
      });
      return res.sendStatus(200);
    }
    
    const starsToBuy = parseInt(action.split('_')[1]);
    const userResult = await pgClient.query('SELECT stars FROM referrals WHERE user_id = $1', [userId]);
    
    if (userResult.rows.length === 0 || userResult.rows[0].stars < starsToBuy) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "❌ لا تمتلك عدد كافي من النجوم. يمكنك كسب المزيد من خلال نظام الأحالات."
      });
      return res.sendStatus(200);
    }
    
    await pgClient.query('UPDATE referrals SET stars = stars - $1 WHERE user_id = $2', [starsToBuy, userId]);
    
    for (let adminId of ADMIN_IDS) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: adminId,
        text: `🛒 طلب شراء نجوم جديد\n👤 المستخدم: @${username}\n⭐ النجوم: ${starsToBuy}\n🆔 ID: ${userId}`,
      });
    }
    
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: userId,
      text: `✅ تم استلام طلبك لشراء ${starsToBuy} نجمة. سيتم إعلامك عند تنفيذ الطلب.`
    });
    
    return res.sendStatus(200);
  }

  // 9. معالجة الكمية المخصصة
  if (body.message?.reply_to_message?.text?.includes("إدخال عدد النجوم")) {
    const starsToBuy = parseInt(body.message.text);
    const userId = body.message.from.id;
    const username = body.message.from.username;
    
    if (isNaN(starsToBuy) || starsToBuy < 50) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "❌ الحد الأدنى لشراء النجوم هو 50 نجمة. يرجى إدخال عدد صحيح أكبر من أو يساوي 50."
      });
      return res.sendStatus(200);
    }
    
    const userResult = await pgClient.query('SELECT stars FROM referrals WHERE user_id = $1', [userId]);
    
    if (userResult.rows.length === 0 || userResult.rows[0].stars < starsToBuy) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "❌ لا تمتلك عدد كافي من النجوم. يمكنك كسب المزيد من خلال نظام الأحالات."
      });
      return res.sendStatus(200);
    }
    
    await pgClient.query('UPDATE referrals SET stars = stars - $1 WHERE user_id = $2', [starsToBuy, userId]);
    
    for (let adminId of ADMIN_IDS) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: adminId,
        text: `🛒 طلب شراء نجوم جديد\n👤 المستخدم: @${username}\n⭐ النجوم: ${starsToBuy}\n🆔 ID: ${userId}`,
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ تأكيد التنفيذ", callback_data: `confirm_stars_${userId}_${starsToBuy}` }]
          ]
        }
      });
    }
    
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: userId,
      text: `✅ تم استلام طلبك لشراء ${starsToBuy} نجمة. سيتم إعلامك عند تنفيذ الطلب.`
    });
    
    return res.sendStatus(200);
  }

  // 10. معالجة رابط الدعوة
  if (body.message?.text?.startsWith("/start") && body.message.text.length > 7) {
    const referralCode = body.message.text.split(' ')[1];
    const userId = body.message.from.id;
    
    const userResult = await pgClient.query('SELECT * FROM referrals WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0 && referralCode) {
      await pgClient.query(
        'INSERT INTO referrals (user_id, username, invited_by) VALUES ($1, $2, $3)',
        [userId, body.message.from.username || 'غير معروف', referralCode]
      );
      
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "🎉 تم تسجيلك بنجاح من خلال رابط الدعوة! يرجى إكمال عملية التحقق."
      });
    }
  }

  // 11. معالجة /start و /help و /database
  if (body.message && body.message.text === "/start") {
    const chatId = body.message.chat.id;
    const welcomeMessage = "مرحبًا بك في Panda Store 🐼\nيمكنك شراء نجوم تليجرام من موقعنا الرسمى🚀\nارسل امر /invite لبدا الربح من البوت";
    const replyMarkup = {
      inline_keyboard: [
        [{ text: "للمشاهدة اضغط هنا 🚀", callback_data: "watch_warning" }],
        [{ text: "للشراء والطلب اضغط هنا 🚀", callback_data: "check_order_time" }],
        [{ text: "انضمام الى قناه الاثباتات", url: "https://t.me/Buy_StarsTG" }]
      ]
    };

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: welcomeMessage,
      reply_markup: replyMarkup
    });
  }
  
  if (body.message && body.message.text === "/help") {
    const chatId = body.message.chat.id;
    const helpMessage = "يمكنك التواصل مع مدير الموقع من هنا:";
    const replyMarkup = {
      inline_keyboard: [
        [{ text: "اتفضل يامحترم 🥰", url: "https://t.me/OMAR_M_SHEHATA" }]
      ]
    };

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: helpMessage,
      reply_markup: replyMarkup
    });
  }
  
  if (body.message && body.message.text === "/database") {
    const chatId = body.message.chat.id;
    const helpMessage = "عرض قائمة الطلبات:";
    const replyMarkup = {
      inline_keyboard: [
        [{ text: "DataBase🚀", web_app:{ url: "https://pandastores.onrender.com/admin.html"} }]
      ]
    };

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: helpMessage,
      reply_markup: replyMarkup
    });
  }
  
  // 12. معالجة الأزرار
  if (body.callback_query) {
    const callbackQuery = body.callback_query;
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;


if (data === "check_order_time") {
  if (!isWorkingHours()) {
    const now = new Date();
    const timeOptions = {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true // هنا نستخدم true لنظام 12 ساعة
    };
    const currentTime = now.toLocaleTimeString('ar-EG', timeOptions);
    
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `❌ عذرًا، نحن خارج مواعيد العمل حاليًا.\n\n🕘 ساعات العمل: من 8 صباحًا حتى 12 منتصف الليل بتوقيت القاهرة (مصر).\n\n⏳ الوقت الحالي في مصر: ${currentTime}\n\n🔁 يرجى المحاولة مرة أخرى خلال ساعات العمل.`
    });
  } else {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: "✅ يمكنك الآن الشراء من خلال الموقع:",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 ابدأ الشراء الآن",url: "https://pandastores.onrender.com"  }]
        ]
      }
    });
  }
}

    try {
      if (data === "contact_admin") {
        const adminMessage = "يمكنك التواصل مع مدير الموقع من هنا:";
        const replyMarkup = {
          inline_keyboard: [
            [{ text: "اتفضل يامحترم 🥰", url: "https://t.me/OMAR_M_SHEHATA" }]
          ]
        };

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: adminMessage,
          reply_markup: replyMarkup
        });
      }

      if (data === "watch_warning") {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: "⚠️ إذا قمت بالشراء من هنا لن يصلني طلبك ⚠️",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 الاستمرار للمشاهدة", web_app: { url: "https://pandastores.netlify.app" } }]
            ]
          }
        });
      }

      if (data.startsWith('complete_')) {
        const orderId = data.split('_')[1];

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: "هل أنت متأكد أن هذا الطلب تم تنفيذه❓",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "نعم ✅", callback_data: `confirmComplete_${orderId}_${messageId}` },
                { text: "لا ❌", callback_data: "cancel" }
              ]
            ]
          }
        });
      }

      if (data.startsWith('confirmComplete_')) {
        const [_, orderId, messageIdToUpdate] = data.split('_');

        await Order.findByIdAndUpdate(orderId, { completed: true });

        try {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
            chat_id: chatId,
            message_id: messageId
          });
        } catch (deleteErr) {
          if (deleteErr.response?.data?.description !== 'Bad Request: message to delete not found') {
            console.error("Error deleting confirmation message:", deleteErr);
          }
        }

        try {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
            chat_id: chatId,
            message_id: messageIdToUpdate,
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ تم تنفيذ هذا الطلب بالفعل", callback_data: "already_completed" }]
              ]
            }
          });
        } catch (editErr) {
          console.error("Error editing message:", editErr);
        }

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: "🎉تم تحديث حالة الطلب بنجاح🎉"
        });
      }

      if (data.startsWith('confirm_stars_')) {
        const [_, userId, stars] = data.split('_');
        
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: userId,
          text: `🎉 تم تنفيذ طلبك لشراء ${stars} نجمة بنجاح! شكرًا لاستخدامك Panda Store.`
        });

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
          chat_id: chatId,
          message_id: messageId
        });
      }

      if (data === "cancel") {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: "❌ تم إلغاء العملية",
          reply_markup: { remove_keyboard: true }
        });
      }

    } catch (error) {
      console.error("❌ خطأ أثناء معالجة زر البوت:", error.response ? error.response.data : error.message);
    }
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("✅ Panda Store backend is running!");
});

const activateWebhook = async () => {
  try {
    const botUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=https://pandastores.onrender.com/telegramWebhook`;
    const { data } = await axios.get(botUrl);
    console.log("✅ Webhook set successfully:", data);
  } catch (error) {
    console.error("❌ Failed to set webhook:", error.response ? error.response.data : error.message);
  }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  await activateWebhook();
});

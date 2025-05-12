require('dotenv').config();
const { Client } = require('pg');
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();

// اتصال PostgreSQL للاحالات (جديد)
const pgClient = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pgClient.connect()
  .then(() => console.log("✅ تم الاتصال بقاعدة بيانات PostgreSQL بنجاح"))
  .catch(err => console.error('❌ فشل الاتصال بقاعدة PostgreSQL:', err));

// اتصال MongoDB للأوامر (الأصلي)
const mongoURI = process.env.MONGO_URI;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_IDS = [process.env.ADMIN_ID, process.env.SECOND_ADMIN_ID];
const CHANNEL_ID= process.env.CHANNEL_ID;
mongoose.connect(mongoURI)
  .then(() => console.log("✅ تم الاتصال بقاعدة بيانات MongoDB Atlas بنجاح"))
  .catch((error) => console.error("❌ فشل الاتصال بقاعدة البيانات:", error));

// المخططات والنماذج (الأصلي)
const orderSchema = new mongoose.Schema({
  username: String,
  stars: Number,
  amountTon: String,
  amountUsd: String,
  createdAt: { type: Date, default: Date.now },
  completed: { type: Boolean, default: false },
});
const Order = mongoose.model('Order', orderSchema);

// إنشاء جدول الاحالات إذا لم يكن موجودًا (جديد)
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
        verification_emojis VARCHAR(50),
        target_emoji VARCHAR(10),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ تم إنشاء/التأكد من جدول referrals بنجاح");
  } catch (err) {
    console.error("❌ خطأ في إنشاء جدول referrals:", err);
  }
})();

// وظائف مساعدة (الأصلي + الجديد)
function isWorkingHours() {
  const now = new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" });
  const hour = new Date(now).getHours();
  return hour >= 9 && hour < 24;
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
        chat_id: process.env.CHANNEL_ID,
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

// Middleware (الأصلي)
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static('public'));

// ==============================================
// كل الكود الأصلي يبقى كما هو بدون أي تعديل
// ==============================================

// الكود الأصلي لـ /order
app.post('/order', async (req, res) => {
  try {
    const { username, stars, amountTon, amountUsd, createdAt } = req.body;
    const orderCreatedAt = createdAt || new Date().toISOString();

    const formattedDate = new Date(orderCreatedAt).toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true, timeZone: 'Africa/Cairo',
    });

    const newOrder = new Order({ username, stars, amountTon, amountUsd, createdAt: orderCreatedAt });
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

// الكود الأصلي لـ /admin
app.get('/admin', async (req, res) => {
  try {
    const orders = await Order.find();
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حدث خطأ أثناء جلب البيانات');
  }
});

// الكود الأصلي لـ /complete-order
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

// الكود الأصلي لـ telegramWebhook
app.post('/telegramWebhook', async (req, res) => {
  const body = req.body;

  // ==============================================
  // الجزء الجديد: التحقق من المستخدمين الروس
  // ==============================================
  if (body.message?.from?.language_code === 'ru') {
    const chatId = body.message.chat.id;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: "⛔ عذرًا، لا نقدم الخدمة للمستخدمين من روسيا."
    });
    return res.sendStatus(200);
  }

  // ==============================================
  // الجزء الجديد: التحقق من الاشتراك في القناة
  // ==============================================
  if (body.message?.text === "/start" || body.message?.text === "/shop" || body.message?.text === "/invite") {
    const chatId = body.message.chat.id;
    const isSubscribed = await isUserSubscribed(chatId);
    if (!isSubscribed) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: "📢 يرجى الاشتراك في قناتنا أولاً لتتمكن من استخدام البوت:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "انضم إلى القناة", url: `https://t.me/${process.env.CHANNEL_ID.replace('@', '')}` }],
            [{ text: "✅ لقد اشتركت", callback_data: "check_subscription" }]
          ]
        }
      });
      return res.sendStatus(200);
    }
  }

  // ==============================================
  // الجزء الجديد: التحقق من رقم الهاتف والايموجي
  // ==============================================
  if (body.message?.text === "/start") {
    const chatId = body.message.chat.id;
    const userResult = await pgClient.query('SELECT * FROM referrals WHERE user_id = $1', [chatId]);
    
    if (userResult.rows.length === 0) {
      // مستخدم جديد - طلب رقم الهاتف
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
      // مستخدم موجود ولكن غير موثق - التحقق بالايموجي
      const emojis = generateRandomEmojis(3);
      const targetEmoji = emojis[Math.floor(Math.random() * emojis.length)];
      
      await pgClient.query('UPDATE referrals SET verification_emojis = $1, target_emoji = $2 WHERE user_id = $3', 
        [emojis.join(','), targetEmoji, chatId]);
      
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: `🔐 للتحقق، يرجى اختيار الايموجي التالي من بين هذه الخيارات:\n\n${emojis.join(' ')}`,
        reply_markup: {
          inline_keyboard: [
            emojis.map(e => ({ text: e, callback_data: `verify_${e}` }))
          ]
        }
      });
      return res.sendStatus(200);
    }
  }

  // ==============================================
  // الجزء الجديد: معالجة التحقق بالايموجي
  // ==============================================
  if (body.callback_query?.data.startsWith('verify_')) {
    const selectedEmoji = body.callback_query.data.split('_')[1];
    const userId = body.callback_query.from.id;
    
    const userResult = await pgClient.query('SELECT target_emoji FROM referrals WHERE user_id = $1', [userId]);
    if (userResult.rows.length > 0) {
      const targetEmoji = userResult.rows[0].target_emoji;
      
      if (selectedEmoji === targetEmoji) {
        await pgClient.query('UPDATE referrals SET verified = true WHERE user_id = $1', [userId]);
        
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: userId,
          text: "✅ تم التحقق بنجاح! يمكنك الآن استخدام البوت.",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 البدء", callback_data: "verified_start" }]
            ]
          }
        });
      } else {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: userId,
          text: "❌ الايموجي الذي اخترته غير صحيح. يرجى المحاولة مرة أخرى."
        });
      }
    }
    return res.sendStatus(200);
  }

  // ==============================================
  // الجزء الجديد: معالجة رقم الهاتف
  // ==============================================
  if (body.message?.contact) {
    const phone = body.message.contact.phone_number;
    const userId = body.message.from.id;
    const username = body.message.from.username || 'غير معروف';
    
    // التحقق من أن رقم الهاتف ليس روسي
    if (phone.startsWith('+7')) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "⛔ عذرًا، لا نقدم الخدمة للمستخدمين من روسيا."
      });
      return res.sendStatus(200);
    }
    
    try {
      await pgClient.query(
        'INSERT INTO referrals (user_id, username, phone_number, verified) VALUES ($1, $2, $3, $4)',
        [userId, username, phone, false]
      );
      
      // إرسال رسالة التحقق بالايموجي
      const emojis = generateRandomEmojis(3);
      const targetEmoji = emojis[Math.floor(Math.random() * emojis.length)];
      
      await pgClient.query('UPDATE referrals SET verification_emojis = $1, target_emoji = $2 WHERE user_id = $3', 
        [emojis.join(','), targetEmoji, userId]);
      
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: `🔐 شكرًا لمشاركة رقم هاتفك. للتحقق، يرجى اختيار الايموجي التالي من بين هذه الخيارات:\n\n${emojis.join(' ')}`,
        reply_markup: {
          inline_keyboard: [
            emojis.map(e => ({ text: e, callback_data: `verify_${e}` }))
          ]
        }
      });
    } catch (err) {
      console.error("Error saving phone number:", err);
    }
    return res.sendStatus(200);
  }

  // ==============================================
  // الجزء الجديد: معالجة الأمر /invite
  // ==============================================
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
      'SELECT COUNT(*) FROM referrals WHERE invited_by = $1', 
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

  // ==============================================
  // الجزء الجديد: معالجة الأمر /shop
  // ==============================================
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
      text: `🛒 متجر النجوم\n\n⭐ النجوم المتاحة: ${userStars}\n\nاختر عدد النجوم التي ترغب في شرائها:`,
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

  // ==============================================
  // الجزء الجديد: معالجة شراء النجوم
  // ==============================================
  if (body.callback_query?.data.startsWith('buy_')) {
    const action = body.callback_query.data;
    const userId = body.callback_query.from.id;
    const username = body.callback_query.from.username;
    
    if (action === "custom_amount") {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "📝 يرجى إدخال عدد النجوم التي ترغب في شرائها (مثال: 55 أو 66):",
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
    
    // خصم النجوم من رصيد المستخدم
    await pgClient.query('UPDATE referrals SET stars = stars - $1 WHERE user_id = $2', [starsToBuy, userId]);
    
    // إرسال إشعار للمشرف
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

  // ==============================================
  // الجزء الجديد: معالجة الكمية المخصصة
  // ==============================================
  if (body.message?.reply_to_message?.text?.includes("إدخال عدد النجوم")) {
    const starsToBuy = parseInt(body.message.text);
    const userId = body.message.from.id;
    const username = body.message.from.username;
    
    if (isNaN(starsToBuy) || starsToBuy <= 0) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "❌ يرجى إدخال عدد صحيح موجب من النجوم."
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
    
    // خصم النجوم من رصيد المستخدم
    await pgClient.query('UPDATE referrals SET stars = stars - $1 WHERE user_id = $2', [starsToBuy, userId]);
    
    // إرسال إشعار للمشرف
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

  // ==============================================
  // الجزء الجديد: معالجة رابط الدعوة
  // ==============================================
  if (body.message?.text?.startsWith("/start") && body.message.text.length > 7) {
    const referralCode = body.message.text.split(' ')[1];
    const userId = body.message.from.id;
    
    // التحقق من أن المستخدم ليس لديه حساب بالفعل
    const userResult = await pgClient.query('SELECT * FROM referrals WHERE user_id = $1', [userId]);
    if (userResult.rows.length === 0 && referralCode) {
      // إضافة نجوم للمدعو
      await pgClient.query(
        'INSERT INTO referrals (user_id, username, invited_by) VALUES ($1, $2, $3)',
        [userId, body.message.from.username || 'غير معروف', referralCode]
      );
      
      // إضافة نجوم للمدعِي
      await pgClient.query(
        'UPDATE referrals SET stars = stars + 1 WHERE referral_code = $1',
        [referralCode]
      );
      
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: "🎉 تم تسجيلك بنجاح من خلال رابط الدعوة! ستحصل على نجوم إضافية عند إكمال التسجيل."
      });
    }
  }

  // ==============================================
  // الكود الأصلي لمعالجة /start و /help و /database
  // ==============================================
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
  
  if (body.callback_query) {
    const callbackQuery = body.callback_query;
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    if (data === "check_order_time") {
      if (!isWorkingHours()) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: "❌ عذرًا، نحن خارج مواعيد العمل حاليًا.\n🕘 ساعات العمل: من 9 صباحًا حتى 12 بليل بتوقيت القاهرة.\n🔁 حاول مرة تانية خلال ساعات العمل."
        });
      } else {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: "✅ يمكنك الآن تقديم طلبك من خلال الموقع:",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 ابدأ الطلب الآن",url: "https://pandastores.onrender.com"  }]
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

        // ✅ حذف رسالة التأكيد
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
          chat_id: chatId,
          message_id: messageId
        });

        // ✅ تحديث الرسالة الأصلية
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageIdToUpdate,
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ تم تنفيذ هذا الطلب بالفعل", callback_data: "already_completed" }]
            ]
          }
        });

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: "🎉تم تحديث حالة الطلب بنجاح🎉"
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

// الكود الأصلي لـ /
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

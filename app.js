const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');
const { Configuration, OpenAIApi } = require('openai');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// 创建 Express 应用
const app = express();
app.use(express.json());

// 环境变量配置
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_BOTNAME = process.env.FEISHU_BOTNAME || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const OPENAI_MAX_TOKEN = parseInt(process.env.OPENAI_MAX_TOKEN) || 1024;

// 初始化 OpenAI API
const configuration = new Configuration({
  apiKey: OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);

// 初始化飞书客户端
const client = new lark.Client({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  domain: lark.Domain.Feishu, // 确保设置为飞书域
  disableTokenCache: false,
});

// 日志辅助函数
function logger(...params) {
  console.debug('[Log]', ...params);
}

// 内存数据库，用于保存会话（如果需要持久化，可使用数据库）
const sessions = {};

// 获取 OpenAI 图片 URL
async function getOpenaiImageUrl(prompt) {
  const resp = await openai.createImage({
    prompt: prompt,
    n: 1,
    size: '1024x1024',
  });
  return resp.data.data[0].url;
}

// 回复消息，增加 uuid 参数
async function reply(messageId, content, uuid) {
  try {
    return await client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify({
          text: content,
        }),
        msg_type: 'text',
        uuid: uuid,
      },
    });
  } catch (e) {
    logger('发送消息到飞书失败', e);
  }
}

// 构建对话上下文
function buildConversation(sessionId, question) {
  const history = sessions[sessionId] || [];
  // 拼接最新的对话
  history.push({ role: 'user', content: question });
  return history;
}

// 保存对话
function saveConversation(sessionId, question, answer) {
  let history = sessions[sessionId] || [];
  history.push({ role: 'assistant', content: answer });
  sessions[sessionId] = history;

  // 检查会话长度，超过限制则移除最早的消息
  let totalSize = history.reduce((acc, msg) => acc + msg.content.length, 0);
  while (totalSize > OPENAI_MAX_TOKEN) {
    history.shift();
    totalSize = history.reduce((acc, msg) => acc + msg.content.length, 0);
  }
}

// 清除对话
function clearConversation(sessionId) {
  delete sessions[sessionId];
}

// 指令处理
async function cmdProcess(cmdParams) {
  if (cmdParams && cmdParams.action.startsWith('/image')) {
    const prompt = cmdParams.action.substring(6).trim();
    logger('生成图片提示词:', prompt);
    const url = await getOpenaiImageUrl(prompt);
    await reply(cmdParams.messageId, url, cmdParams.messageId);
    return;
  }
  switch (cmdParams && cmdParams.action) {
    case '/help':
      await cmdHelp(cmdParams.messageId);
      break;
    case '/clear':
      await cmdClear(cmdParams.sessionId, cmdParams.messageId);
      break;
    default:
      await cmdHelp(cmdParams.messageId);
      break;
  }
  return { code: 0 };
}

// 帮助指令
async function cmdHelp(messageId) {
  const helpText = `ChatGPT 指令使用指南

Usage:
/clear          清除上下文
/help           获取更多帮助
/image [提示词]  根据提示词生成图片
`;
  await reply(messageId, helpText, messageId);
}

// 清除记忆指令
async function cmdClear(sessionId, messageId) {
  clearConversation(sessionId);
  await reply(messageId, '✅ 记忆已清除', messageId);
}

// 获取 OpenAI 回复
async function getOpenAIReply(prompt) {
  try {
    const response = await openai.createChatCompletion({
      model: OPENAI_MODEL,
      messages: prompt,
    });
    // 返回回复内容
    return response.data.choices[0].message.content.trim();
  } catch (e) {
    logger('OpenAI API 请求出错:', e.response ? e.response.data : e);
    return '抱歉，我无法回答您的问题。';
  }
}

// 自检函数
function doctor() {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_BOTNAME || !OPENAI_KEY) {
    return {
      code: 1,
      message: '环境变量配置不完整，请检查。',
    };
  }
  return {
    code: 0,
    message: '✅ 配置成功，可以正常使用。',
  };
}

// 获取 Tenant Access Token
async function getTenantAccessToken() {
  try {
    const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/', {
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    });
    logger('Tenant Access Token Response:', res.data);
    return res.data.tenant_access_token;
  } catch (error) {
    logger('Error retrieving tenant access token:', error.response ? error.response.data : error);
    throw error;
  }
}

// 处理回复
async function handleReply(userInput, sessionId, messageId) {
  const question = userInput.text.replace('@_user_1', '').trim();
  logger('收到问题:', question);
  const action = question.trim();
  if (action.startsWith('/')) {
    return await cmdProcess({ action, sessionId, messageId });
  }
  const prompt = buildConversation(sessionId, question);
  const openaiResponse = await getOpenAIReply(prompt);
  saveConversation(sessionId, question, openaiResponse);
  await reply(messageId, openaiResponse, messageId);
  return { code: 0 };
}

// 处理飞书的 webhook 请求
app.post('/webhook', async (req, res) => {
  const params = req.body;

  // 处理飞书的验证请求
  if (params.type === 'url_verification') {
    logger('处理飞书的 URL 验证');
    return res.send({ challenge: params.challenge });
  }

  // 自检逻辑
  if (!params.header || !params.event) {
    logger('参数不完整，执行自检');
    const checkResult = doctor();
    return res.status(200).send(checkResult);
  }

  // 处理飞书的事件回调
  if (params.header.event_type === 'im.message.receive_v1') {
    const eventId = params.header.event_id;
    const messageId = params.event.message.message_id;
    const chatId = params.event.message.chat_id;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = chatId + senderId;

    // 忽略机器人自己的消息
    const isFromBot = params.event.sender.sender_type === 'bot';
    if (isFromBot) {
      logger('忽略机器人自己的消息');
      return res.status(200).send({ code: 0 });
    }

    // 获取消息的创建时间并检查是否为历史消息
    const createTime = Number(params.event.message.create_time);
    const currentTime = Date.now();
    const timeDifference = currentTime - createTime;
    if (timeDifference > 10000) { // 时间阈值可以根据需要调整
      logger('忽略历史消息', messageId);
      return res.status(200).send({ code: 0 });
    }

    // 私聊直接回复
    if (params.event.message.chat_type === 'p2p') {
      // 处理文本消息
      if (params.event.message.message_type === 'text') {
        const userInput = JSON.parse(params.event.message.content);
        await handleReply(userInput, sessionId, messageId);
        return res.status(200).send({ code: 0 });
      }

      // 处理语音消息
      if (params.event.message.message_type === 'audio') {
        try {
          // 获取文件 key
          const fileKey = JSON.parse(params.event.message.content).file_key;

          // 获取 Tenant Access Token
          const tenantAccessToken = await getTenantAccessToken();
          if (!tenantAccessToken) {
            logger('Tenant access token is undefined');
            throw new Error('Failed to retrieve tenant access token');
          }

          // 编码 messageId 和 fileKey
          const encodedMessageId = encodeURIComponent(messageId);
          const encodedFileKey = encodeURIComponent(fileKey);

          // 构建请求 URL
          const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodedMessageId}/resources/${encodedFileKey}/fetch`;

          // 获取文件内容
          const axiosResponse = await axios.get(url, {
            headers: {
              Authorization: `Bearer ${tenantAccessToken}`,
            },
            responseType: 'stream',
          });

          // 保存文件到本地
          const audioFilePath = path.join(__dirname, `audio_${messageId}.mp3`); // 使用原始格式
          const writer = fs.createWriteStream(audioFilePath);
          axiosResponse.data.pipe(writer);

          // 等待文件下载完成
          await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
          });

          // 转换音频格式为 mp3
          const convertedAudioPath = path.join(__dirname, `audio_${messageId}_converted.mp3`);
          await new Promise((resolve, reject) => {
            ffmpeg(audioFilePath)
              .toFormat('mp3')
              .on('error', (err) => {
                logger('音频格式转换错误:', err.message);
                reject(err);
              })
              .on('end', () => {
                logger('音频格式转换完成');
                resolve();
              })
              .save(convertedAudioPath);
          });

          // 使用 OpenAI Whisper API 转换语音为文字
          const transcriptionResponse = await openai.createTranscription(
            fs.createReadStream(convertedAudioPath),
            'whisper-1'
          );

          // 获取转换后的文字
          const transcribedText = transcriptionResponse.data.text;
          logger('语音转文字结果:', transcribedText);

          // 处理转换后的文字
          await handleReply({ text: transcribedText }, sessionId, messageId);

          // 删除临时音频文件
          fs.unlinkSync(audioFilePath);
          fs.unlinkSync(convertedAudioPath);

          return res.status(200).send({ code: 0 });
        } catch (e) {
          logger('处理语音消息出错:', e.message, e.stack);
          await reply(messageId, '抱歉，无法处理您的语音消息。', messageId);
          return res.status(200).send({ code: 0 });
        }
      }

      // 不支持的消息类型
      await reply(messageId, '暂不支持处理此类型的消息。', messageId);
      logger('不支持的消息类型');
      return res.status(200).send({ code: 0 });
    }

    // 群聊，需要 @ 机器人
    if (params.event.message.chat_type === 'group') {
      // 检查是否提及了机器人
      if (
        !params.event.message.mentions ||
        params.event.message.mentions.length === 0
      ) {
        logger('未提及机器人，忽略消息');
        return res.status(200).send({ code: 0 });
      }
      const botMentioned = params.event.message.mentions.some(
        (mention) => mention.name === FEISHU_BOTNAME ||
                     mention.id === params.event.sender.sender_id.user_id
      );
      if (!botMentioned) {
        logger('机器人未被提及，忽略消息');
        return res.status(200).send({ code: 0 });
      }

      // 处理文本消息
      if (params.event.message.message_type === 'text') {
        const userInput = JSON.parse(params.event.message.content);
        await handleReply(userInput, sessionId, messageId);
        return res.status(200).send({ code: 0 });
      }

      // 处理语音消息
      if (params.event.message.message_type === 'audio') {
        try {
          // 获取文件 key
          const fileKey = JSON.parse(params.event.message.content).file_key;

          // 获取 Tenant Access Token
          const tenantAccessToken = await getTenantAccessToken();
          if (!tenantAccessToken) {
            logger('Tenant access token is undefined');
            throw new Error('Failed to retrieve tenant access token');
          }

          // 编码 messageId 和 fileKey
          const encodedMessageId = encodeURIComponent(messageId);
          const encodedFileKey = encodeURIComponent(fileKey);

          // 构建请求 URL
          const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodedMessageId}/resources/${encodedFileKey}/fetch`;

          // 获取文件内容
          const axiosResponse = await axios.get(url, {
            headers: {
              Authorization: `Bearer ${tenantAccessToken}`,
            },
            responseType: 'stream',
          });

          // 保存文件到本地
          const audioFilePath = path.join(__dirname, `audio_${messageId}.mp3`); // 使用原始格式
          const writer = fs.createWriteStream(audioFilePath);
          axiosResponse.data.pipe(writer);

          // 等待文件下载完成
          await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
          });

          // 转换音频格式为 mp3
          const convertedAudioPath = path.join(__dirname, `audio_${messageId}_converted.mp3`);
          await new Promise((resolve, reject) => {
            ffmpeg(audioFilePath)
              .toFormat('mp3')
              .on('error', (err) => {
                logger('音频格式转换错误:', err.message);
                reject(err);
              })
              .on('end', () => {
                logger('音频格式转换完成');
                resolve();
              })
              .save(convertedAudioPath);
          });

          // 使用 OpenAI Whisper API 转换语音为文字
          const transcriptionResponse = await openai.createTranscription(
            fs.createReadStream(convertedAudioPath),
            'whisper-1'
          );

          // 获取转换后的文字
          const transcribedText = transcriptionResponse.data.text;
          logger('语音转文字结果:', transcribedText);

          // 处理转换后的文字
          await handleReply({ text: transcribedText }, sessionId, messageId);

          // 删除临时音频文件
          fs.unlinkSync(audioFilePath);
          fs.unlinkSync(convertedAudioPath);

          return res.status(200).send({ code: 0 });
        } catch (e) {
          logger('处理语音消息出错:', e.message, e.stack);
          await reply(messageId, '抱歉，无法处理您的语音消息。', messageId);
          return res.status(200).send({ code: 0 });
        }
      }

      // 不支持的消息类型
      await reply(messageId, '暂不支持处理此类型的消息。', messageId);
      logger('不支持的消息类型');
      return res.status(200).send({ code: 0 });
    }
  }

  logger('未处理的事件类型');
  res.status(200).send({ code: 2 });
});

// 添加对 GET 请求的处理，以避免 404 错误
app.get('/webhook', (req, res) => {
  res.status(200).send('Webhook endpoint is up and running.');
});

// 导出应用
module.exports = app;

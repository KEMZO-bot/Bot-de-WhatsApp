import 'dotenv/config';
import { Blob } from 'buffer';
import fs from 'fs';
import path from 'path';
import http from 'http';
import wweb from 'whatsapp-web.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import ytdl from 'ytdl-core';
import ytSearch from 'yt-search';
import axios from 'axios';

const { Client, LocalAuth, MessageMedia } = wweb;

// Polyfill para File
if (typeof global.File === 'undefined') {
    global.File = class File extends Blob {
        constructor(parts, name, options) {
            super(parts, options);
            this.name = name;
        }
    };
}

// ---------- CONFIGURACIÓN ----------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PHONE_NUMBER = process.env.PHONE_NUMBER || '584129684011';

if (!GEMINI_API_KEY) {
    console.error('❌ ERROR: GEMINI_API_KEY no está configurada');
    process.exit(1);
}

// ---------- SERVIDOR HTTP (mantiene vivo Render) ----------
const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot WhatsApp activo ✅');
});
server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP en puerto ${PORT}`);
});

// ---------- IA ----------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
let model;
try {
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    console.log('✅ Usando modelo: gemini-2.0-flash-exp');
} catch (err) {
    console.log('⚠️  Modelo nuevo no disponible, usando gemini-pro');
    model = genAI.getGenerativeModel({ model: "gemini-pro" });
}

// Cola de concurrencia
class AsyncQueue {
    constructor(concurrency = 2) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }
    async run(task) {
        if (this.running >= this.concurrency) {
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.running++;
        try { await task(); } finally {
            this.running--;
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                next();
            }
        }
    }
}
const messageQueue = new AsyncQueue(2);

const messageStore = new Map();
const personalityMap = new Map();
const userSpamCount = new Map();
const spamPhrases = [
    "Dejen de joder, ando ocupado",
    "¿Tanto mensaje? Relájate",
    "No me hagas explotar, dame un respiro",
    "Escribe más lento, humano",
];

// ---------- FUNCIONES AUXILIARES ----------
async function safeTyping(chat) {
    try { await Promise.race([chat.sendStateTyping(), new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))]); } catch {}
}
async function safeRecording(chat) {
    try { await Promise.race([chat.sendStateRecording(), new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))]); } catch {}
}
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

async function downloadAudio(url) {
    const filePath = path.join('/tmp', `audio_${Date.now()}.mp3`);
    return new Promise((resolve, reject) => {
        const stream = ytdl(url, { filter: 'audioonly', quality: 'lowestaudio', highWaterMark: 1 << 16 });
        const writeStream = fs.createWriteStream(filePath);
        stream.pipe(writeStream);
        writeStream.on('finish', () => resolve(filePath));
        writeStream.on('error', reject);
        stream.on('error', reject);
    });
}

async function downloadVideo(url) {
    const filePath = path.join('/tmp', `video_${Date.now()}.mp4`);
    return new Promise((resolve, reject) => {
        const stream = ytdl(url, { quality: 'lowest', highWaterMark: 1 << 16 });
        const writeStream = fs.createWriteStream(filePath);
        stream.pipe(writeStream);
        writeStream.on('finish', () => resolve(filePath));
        writeStream.on('error', reject);
        stream.on('error', reject);
    });
}

async function searchImage(query) {
    console.log(`🔍 Buscando imagen: "${query}"`);
    try {
        const res = await axios.get('https://pixabay.com/api/', {
            params: {
                key: '25516218-6e8b5e2a1f1c3d0e8b5e2a1f1',
                q: query,
                per_page: 3,
                safesearch: 'true'
            },
            timeout: 10000
        });
        if (res.data.hits && res.data.hits.length > 0) {
            const imageUrl = res.data.hits[0].largeImageURL || res.data.hits[0].webformatURL;
            console.log('✅ Imagen encontrada en Pixabay');
            return imageUrl;
        }
    } catch (err) {
        console.log('⚠️  Pixabay falló, intentando alternativa...');
    }
    try {
        const encodedQuery = encodeURIComponent(query);
        const unsplashUrl = `https://source.unsplash.com/featured/?${encodedQuery}`;
        const res = await axios.head(unsplashUrl, {
            maxRedirects: 0,
            validateStatus: status => status === 302 || status === 200,
            timeout: 10000
        });
        if (res.headers.location) {
            console.log('✅ Imagen encontrada en Unsplash');
            return res.headers.location;
        }
    } catch (err) {
        if (err.response?.headers?.location) {
            console.log('✅ Imagen encontrada en Unsplash (redirect)');
            return err.response.headers.location;
        }
    }
    console.log('⚠️  Usando imagen de respaldo');
    return `https://picsum.photos/800/600?random=${Date.now()}`;
}

async function getRandomMeme() {
    try {
        const res = await axios.get('https://meme-api.com/gimme');
        return res.data.url;
    } catch (err) {
        console.error('Error al obtener meme:', err);
        return null;
    }
}

function checkSpam(userId) {
    const now = Date.now();
    const record = userSpamCount.get(userId);
    if (!record || (now - record.firstTime) > 5000) {
        userSpamCount.set(userId, { count: 1, firstTime: now });
        return false;
    }
    record.count++;
    if (record.count > 3) {
        userSpamCount.set(userId, { count: 1, firstTime: now });
        return true;
    }
    return false;
}

function addMessageToHistory(chatId, msg) {
    if (!messageStore.has(chatId)) messageStore.set(chatId, []);
    const history = messageStore.get(chatId);
    history.push({ from: msg.author || msg.from, body: msg.body, timestamp: Date.now() });
    if (history.length > 15) history.shift();
}

// ---------- CLIENTE ----------
let client;
let reconnectAttempt = 0;

function createClient() {
    return new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-gpu', '--no-zygote', '--single-process', '--no-first-run',
                '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
                '--memory-pressure-off', '--disable-ipc-flooding-protection'
            ]
        }
    });
}

// ---------- MANEJADOR DE MENSAJES ----------
async function handleMessage(msg) {
    const chat = await msg.getChat();
    const body = msg.body?.trim() || '';
    const userId = msg.author || msg.from;
    const isGroup = chat.isGroup;
    const botId = client.info.wid._serialized;

    console.log(`📩 [${msg.from}] ${body}`);

    if (checkSpam(userId)) {
        const phrase = spamPhrases[Math.floor(Math.random() * spamPhrases.length)];
        await chat.sendMessage(phrase);
        return;
    }

    if (isGroup) addMessageToHistory(msg.from, msg);

    const isCommand = body.startsWith('#') || body.startsWith('/');

    if (isCommand) {
        const args = body.slice(1).split(' ');
        const cmd = args[0].toLowerCase();
        const argText = args.slice(1).join(' ');

        if (cmd === 'musica' || cmd === 'descargar') await safeRecording(chat);
        else await safeTyping(chat);

        if (cmd !== 'start') await delay(3000 + Math.random() * 2000);
        else await delay(1000);

        try {
            switch (cmd) {
                case 'start': {
                    const welcome = `🔥 *Bot activo*

Comandos:
- \`#musica <nombre>\` → Audio de YouTube
- \`#descargar <link>\` → Descarga video YouTube
- \`#hablar\` → Respuesta contextual (últimos 15 msgs)
- \`#pin <término>\` → Imagen de internet
- \`#meme\` → Meme aleatorio
- \`#personalidad Seria|Pana\` → Estilo de conversación
- \`#close\` / \`#open\` → Cerrar/Abrir grupo (solo admins)
- \`/start\` → Este mensaje

También respondo si me etiquetan.`;
                    await msg.reply(welcome);
                    break;
                }
                case 'musica': {
                    if (!argText) { await msg.reply('⚠️ Escribe el nombre de la canción'); break; }
                    await msg.reply('🔍 Buscando en YouTube...');
                    try {
                        const results = await ytSearch(argText);
                        const video = results.videos[0];
                        if (!video) { await msg.reply('❌ No encontré la canción'); break; }
                        await msg.reply(`🎵 *${video.title}* - Descargando...`);
                        const audioPath = await downloadAudio(video.url);
                        const media = MessageMedia.fromFilePath(audioPath);
                        await client.sendMessage(msg.from, media, { sendAudioAsVoice: true });
                        fs.promises.unlink(audioPath).catch(() => {});
                    } catch (err) {
                        console.error('Error en música:', err);
                        await msg.reply('❌ Error al buscar/descargar.');
                    }
                    break;
                }
                case 'descargar': {
                    if (!argText) { await msg.reply('⚠️ Proporciona un enlace de YouTube'); break; }
                    if (!ytdl.validateURL(argText)) {
                        await msg.reply('❌ Por ahora solo soporto enlaces de YouTube.');
                        break;
                    }
                    await msg.reply('📥 Descargando video...');
                    try {
                        const videoPath = await downloadVideo(argText);
                        const media = MessageMedia.fromFilePath(videoPath);
                        await client.sendMessage(msg.from, media, { caption: 'Aquí tienes tu video' });
                        fs.promises.unlink(videoPath).catch(() => {});
                    } catch (err) {
                        console.error('Error descargando:', err);
                        await msg.reply('❌ Error al descargar.');
                    }
                    break;
                }
                case 'hablar': {
                    const personality = personalityMap.get(msg.from) || 'pana';
                    let prompt;
                    if (isGroup) {
                        const history = messageStore.get(msg.from) || [];
                        const context = history.slice(-15).map(m => `${m.from}: ${m.body}`).join('\n');
                        prompt = `Eres un amigo en un grupo de WhatsApp. Personalidad: ${personality}. Responde al último mensaje considerando este contexto:\n${context}\nNo menciones que eres una IA. Sé natural. Responde en español.`;
                    } else {
                        prompt = `Eres un amigo personal. Personalidad: ${personality}. Responde: "${body.slice(7).trim()}". No menciones IA. Responde en español.`;
                    }
                    try {
                        const result = await model.generateContent(prompt);
                        await msg.reply(result.response.text());
                    } catch (err) {
                        console.error('Error en Gemini:', err.message);
                        try {
                            console.log('🔄 Reintentando con gemini-pro...');
                            const fallbackModel = genAI.getGenerativeModel({ model: "gemini-pro" });
                            const result = await fallbackModel.generateContent(prompt);
                            await msg.reply(result.response.text());
                        } catch (fallbackErr) {
                            await msg.reply('❌ Error al generar respuesta.');
                        }
                    }
                    break;
                }
                case 'pin': {
                    if (!argText) { await msg.reply('⚠️ Dime qué imagen buscar'); break; }
                    await msg.reply(`🔍 Buscando imagen de "${argText}"...`);
                    const imgUrl = await searchImage(argText);
                    try {
                        const media = await MessageMedia.fromUrl(imgUrl, { unsafeMime: true });
                        await client.sendMessage(msg.from, media, { caption: `🖼️ ${argText}` });
                    } catch (err) {
                        console.error('Error enviando imagen:', err);
                        await msg.reply('❌ No se pudo enviar la imagen.');
                    }
                    break;
                }
                case 'meme': {
                    await msg.reply('🔍 Buscando meme...');
                    const memeUrl = await getRandomMeme();
                    if (!memeUrl) { await msg.reply('❌ No pude obtener un meme ahora.'); break; }
                    const media = await MessageMedia.fromUrl(memeUrl, { unsafeMime: true });
                    await client.sendMessage(msg.from, media, { caption: 'Meme del día' });
                    break;
                }
                case 'personalidad': {
                    const tipo = argText.toLowerCase();
                    if (tipo === 'seria') {
                        personalityMap.set(msg.from, 'seria');
                        await msg.reply('🧑‍💼 Modo serio activado.');
                    } else if (tipo === 'pana') {
                        personalityMap.set(msg.from, 'pana');
                        await msg.reply('😈 Modo pana activado.');
                    } else {
                        await msg.reply('⚠️ Usa: #personalidad Seria o #personalidad Pana');
                    }
                    break;
                }
                case 'close': {
                    if (!isGroup) { await msg.reply('❌ Solo en grupos'); break; }
                    const authorId = msg.author || msg.from;
                    await chat.fetchMessages({ limit: 1 });
                    const participant = chat.participants.find(p => {
                        const pId = p.id._serialized || p.id.user || p.id;
                        return pId === authorId || pId.includes(authorId.split('@')[0]) || authorId.includes(pId.split('@')[0]);
                    });
                    if (!participant || !participant.isAdmin) {
                        await msg.reply('❌ Solo administradores');
                        break;
                    }
                    await chat.setMessagesAdminsOnly(true);
                    await msg.reply('🔒 Grupo cerrado');
                    break;
                }
                case 'open': {
                    if (!isGroup) { await msg.reply('❌ Solo en grupos'); break; }
                    const authorId = msg.author || msg.from;
                    await chat.fetchMessages({ limit: 1 });
                    const participant = chat.participants.find(p => {
                        const pId = p.id._serialized || p.id.user || p.id;
                        return pId === authorId || pId.includes(authorId.split('@')[0]) || authorId.includes(pId.split('@')[0]);
                    });
                    if (!participant || !participant.isAdmin) {
                        await msg.reply('❌ Solo administradores');
                        break;
                    }
                    await chat.setMessagesAdminsOnly(false);
                    await msg.reply('🔓 Grupo abierto');
                    break;
                }
                default:
                    await msg.reply('❓ Comando no existente');
            }
        } catch (err) {
            console.error('Error en comando:', err);
            await msg.reply('❌ Error al procesar el comando.');
        }
        return;
    }

    // Menciones
    if (msg.mentionedIds.includes(botId)) {
        await safeTyping(chat);
        await delay(3000 + Math.random() * 2000);
        const personality = personalityMap.get(msg.from) || 'pana';
        const prompt = `Te mencionaron. Personalidad: ${personality}. Mensaje: "${body}". Responde en español. No menciones IA.`;
        try {
            const result = await model.generateContent(prompt);
            await msg.reply(result.response.text());
        } catch (err) {
            console.error('Error en mención:', err);
        }
        return;
    }

    // Chat privado
    if (!isGroup && body) {
        await safeTyping(chat);
        await delay(3000 + Math.random() * 2000);
        const personality = personalityMap.get(msg.from) || 'pana';
        const prompt = `Eres un amigo. Personalidad: ${personality}. Mensaje: "${body}". Responde en español. No menciones IA.`;
        try {
            const result = await model.generateContent(prompt);
            await msg.reply(result.response.text());
        } catch (err) {
            console.error('Error en respuesta privada:', err);
        }
    }
}

// ---------- MANEJO DE ERRORES ----------
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('🔥 Uncaught Exception:', err));

// ---------- INICIALIZACIÓN ----------
async function initialize() {
    client = createClient();

    client.on('qr', async (qr) => {
        try {
            const pairingCode = await client.requestPairingCode(PHONE_NUMBER);
            console.log('\n🔑 CÓDIGO DE VINCULACIÓN:', pairingCode);
            console.log('📱 WhatsApp > Dispositivos vinculados > Vincular con código\n');
        } catch (err) {
            console.error('❌ Error al generar código:', err.message);
        }
    });

    client.on('ready', () => {
        console.log('✅ BOT CONECTADO Y LISTO');
        reconnectAttempt = 0;
    });

    client.on('disconnected', async (reason) => {
        console.log(`❌ Desconectado: ${reason}`);
        await reconnect();
    });

    client.on('message', async (msg) => {
        if (msg.fromMe || msg.isStatus) return;
        messageQueue.run(() => handleMessage(msg));
    });

    try {
        await client.initialize();
    } catch (err) {
        console.error('Error al inicializar:', err);
        await reconnect();
    }
}

async function reconnect() {
    const delayMs = Math.min(5000 * Math.pow(2, reconnectAttempt), 300000);
    reconnectAttempt++;
    console.log(`🔁 Reintentando en ${delayMs / 1000}s...`);
    setTimeout(async () => {
        try { if (client) await client.destroy(); } catch (_) {}
        await initialize();
    }, delayMs);
}

initialize();

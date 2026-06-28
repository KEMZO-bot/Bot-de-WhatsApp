import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';
import ytdl from 'ytdl-core';
import ytSearch from 'yt-search';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import Pino from 'pino';

const logger = Pino({ level: 'silent' });

// ---------- CONFIGURACIÓN ----------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PHONE_NUMBER = process.env.PHONE_NUMBER || '584129684011';

if (!GEMINI_API_KEY) {
    console.error('❌ ERROR: GEMINI_API_KEY no está configurada');
    process.exit(1);
}

// ---------- SERVIDOR HTTP ----------
const PORT = process.env.PORT || 10000;
let sock = null;
let currentQR = null;

const server = http.createServer((req, res) => {
    if (req.url === '/qr' && currentQR) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>QR WhatsApp</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{background:#111;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;flex-direction:column}#qrcode{background:white;padding:20px;border-radius:15px}h2{color:white;font-family:Arial;margin-bottom:20px}</style></head><body><h2>📱 Escanea este QR</h2><div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById("qrcode"),{text:"${currentQR.replace(/"/g,'\\"')}",width:350,height:350})</script></body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Bot activo ✅');
    }
});
server.listen(PORT, () => console.log(`🌐 Servidor en puerto ${PORT}`));

// ---------- IA ----------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const MODEL_NAME = "gemini-2.0-flash";
const model = genAI.getGenerativeModel({ model: MODEL_NAME });
console.log('✅ Modelo IA: ' + MODEL_NAME);

// ---------- ESTADOS ----------
const messageStore = new Map();
const personalityMap = new Map();
const userSpamCount = new Map();
const spamPhrases = ["Dejen de joder, ando ocupado", "¿Tanto mensaje? Relájate", "No me hagas explotar, dame un respiro", "Escribe más lento, humano"];

// ---------- FUNCIONES ----------
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadAudio(url) {
    const fp = path.join('/tmp', `audio_${Date.now()}.mp3`);
    return new Promise((resolve, reject) => {
        const s = ytdl(url, { filter: 'audioonly', quality: 'lowestaudio', highWaterMark: 1 << 16 });
        const w = fs.createWriteStream(fp);
        s.pipe(w);
        w.on('finish', () => resolve(fp));
        w.on('error', reject);
        s.on('error', reject);
    });
}

async function downloadVideo(url) {
    const fp = path.join('/tmp', `video_${Date.now()}.mp4`);
    return new Promise((resolve, reject) => {
        const s = ytdl(url, { quality: 'lowest', highWaterMark: 1 << 16 });
        const w = fs.createWriteStream(fp);
        s.pipe(w);
        w.on('finish', () => resolve(fp));
        w.on('error', reject);
        s.on('error', reject);
    });
}

async function searchImage(query) {
    console.log(`🔍 Buscando imagen: "${query}"`);
    try {
        const r = await axios.get('https://pixabay.com/api/', { params: { key: '25516218-6e8b5e2a1f1c3d0e8b5e2a1f1', q: query, per_page: 3, safesearch: 'true' }, timeout: 10000 });
        if (r.data.hits?.length) {
            console.log('✅ Imagen encontrada en Pixabay');
            return r.data.hits[0].largeImageURL || r.data.hits[0].webformatURL;
        }
    } catch (err) {
        console.log('⚠️ Pixabay falló:', err.message);
    }
    console.log('⚠️ Usando Unsplash como respaldo');
    return `https://source.unsplash.com/800x600/?${encodeURIComponent(query)}`;
}

async function getRandomMeme() {
    try { 
        const r = await axios.get('https://meme-api.com/gimme/memesesp', { timeout: 10000 });
        if (r.data?.url) return r.data.url;
    } catch {}
    try { 
        const r = await axios.get('https://meme-api.com/gimme/spanishmemes', { timeout: 10000 });
        if (r.data?.url) return r.data.url;
    } catch {}
    try { 
        const r = await axios.get('https://meme-api.com/gimme', { timeout: 10000 });
        return r.data.url;
    } catch { return null; }
}

function checkSpam(uid) {
    const now = Date.now();
    const rec = userSpamCount.get(uid);
    if (!rec || (now - rec.firstTime) > 5000) { userSpamCount.set(uid, { count: 1, firstTime: now }); return false; }
    if (++rec.count > 3) { userSpamCount.set(uid, { count: 1, firstTime: now }); return true; }
    return false;
}

function addMessageToHistory(cid, msg) {
    if (!messageStore.has(cid)) messageStore.set(cid, []);
    const h = messageStore.get(cid);
    h.push({ from: msg.key.participant || msg.key.remoteJid, body: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '', timestamp: Date.now() });
    if (h.length > 15) h.shift();
}

// ---------- CONEXIÓN WHATSAPP ----------
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: ['Bot WhatsApp', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('\n📱 QR: ' + (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`) + '/qr\n');
            qrcode.generate(qr, { small: true });

            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log('\n🔑 CÓDIGO:', code, '\n');
            } catch {}
        }

        if (connection === 'open') {
            console.log('✅ BOT CONECTADO Y LISTO');
            currentQR = null;
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error;
            console.log('❌ Desconectado:', reason);
            if (reason?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(connectToWhatsApp, 5000);
            }
        }
    });

    // ---------- MANEJADOR DE MENSAJES ----------
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        const uid = msg.key.participant || jid;
        const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';

        console.log(`📩 [${jid}] ${body}`);

        if (!body) return;

        if (checkSpam(uid)) {
            await sock.sendMessage(jid, { text: spamPhrases[Math.floor(Math.random() * spamPhrases.length)] });
            return;
        }

        if (isGroup) addMessageToHistory(jid, msg);

        const isCmd = body.startsWith('#') || body.startsWith('/');
        if (!isCmd) {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentioned.includes(botId)) {
                await sock.sendPresenceUpdate('composing', jid);
                await delay(3000 + Math.random() * 2000);
                const p = personalityMap.get(jid) || 'pana';
                try {
                    const r = await model.generateContent(`Te mencionaron. Personalidad: ${p}. Mensaje: "${body}". Responde en español. No menciones IA.`);
                    await sock.sendMessage(jid, { text: r.response.text() });
                } catch (err) {
                    console.error('Error mención:', err.message);
                }
                return;
            }
            if (!isGroup && body) {
                await sock.sendPresenceUpdate('composing', jid);
                await delay(3000 + Math.random() * 2000);
                const p = personalityMap.get(jid) || 'pana';
                try {
                    const r = await model.generateContent(`Amigo. Personalidad: ${p}. Mensaje: "${body}". Responde en español. No menciones IA.`);
                    await sock.sendMessage(jid, { text: r.response.text() });
                } catch (err) {
                    console.error('Error chat:', err.message);
                }
            }
            return;
        }

        const args = body.slice(1).split(' ');
        const cmd = args[0].toLowerCase();
        const arg = args.slice(1).join(' ');

        if (cmd === 'musica' || cmd === 'descargar') await sock.sendPresenceUpdate('recording', jid);
        else await sock.sendPresenceUpdate('composing', jid);
        await delay(cmd === 'start' ? 1000 : 3000 + Math.random() * 2000);

        try {
            switch (cmd) {
                case 'start':
                    await sock.sendMessage(jid, { text: '🔥 *Bot activo*\n\n#musica <nombre>\n#descargar <link>\n#hablar\n#pin <término>\n#meme\n#personalidad Seria|Pana\n#close / #open\n/start' });
                    break;
                case 'musica':
                    if (!arg) { await sock.sendMessage(jid, { text: '⚠️ Escribe el nombre de la canción' }); break; }
                    await sock.sendMessage(jid, { text: '🔍 Buscando en YouTube...' });
                    try {
                        const sr = await ytSearch(arg);
                        const v = sr.videos[0];
                        if (!v) { await sock.sendMessage(jid, { text: '❌ No encontré la canción' }); break; }
                        await sock.sendMessage(jid, { text: `🎵 *${v.title}* - Descargando...` });
                        const ap = await downloadAudio(v.url);
                        await sock.sendMessage(jid, { 
                            audio: fs.readFileSync(ap), 
                            mimetype: 'audio/mp4', 
                            ptt: true 
                        });
                        fs.promises.unlink(ap).catch(() => {});
                    } catch (err) {
                        console.error('Error música:', err);
                        await sock.sendMessage(jid, { text: '❌ Error al descargar la música' });
                    }
                    break;
                case 'descargar':
                    if (!arg) { await sock.sendMessage(jid, { text: '⚠️ Pega el enlace de YouTube' }); break; }
                    if (!ytdl.validateURL(arg)) { await sock.sendMessage(jid, { text: '❌ Solo soporto enlaces de YouTube' }); break; }
                    await sock.sendMessage(jid, { text: '📥 Descargando video...' });
                    try {
                        const vp = await downloadVideo(arg);
                        await sock.sendMessage(jid, { 
                            video: fs.readFileSync(vp), 
                            caption: 'Aquí tienes tu video' 
                        });
                        fs.promises.unlink(vp).catch(() => {});
                    } catch (err) {
                        console.error('Error video:', err);
                        await sock.sendMessage(jid, { text: '❌ Error al descargar el video' });
                    }
                    break;
                case 'hablar':
                    const pers = personalityMap.get(jid) || 'pana';
                    let prompt;
                    if (isGroup) {
                        const ctx = (messageStore.get(jid) || []).slice(-15).map(m => `${m.from}: ${m.body}`).join('\n');
                        prompt = `Amigo en grupo. Personalidad: ${pers}. Contexto:\n${ctx}\nResponde en español. No menciones IA.`;
                    } else {
                        prompt = `Amigo personal. Personalidad: ${pers}. Mensaje: "${arg}". Responde en español. No menciones IA.`;
                    }
                    try {
                        const r = await model.generateContent(prompt);
                        await sock.sendMessage(jid, { text: r.response.text() });
                    } catch (err) {
                        console.error('Error hablar:', err.message);
                        await sock.sendMessage(jid, { text: '❌ Error IA: ' + err.message.substring(0, 80) });
                    }
                    break;
                case 'pin':
                    if (!arg) { await sock.sendMessage(jid, { text: '⚠️ Dime qué imagen buscar' }); break; }
                    await sock.sendMessage(jid, { text: `🔍 Buscando imagen de "${arg}"...` });
                    const img = await searchImage(arg);
                    try { await sock.sendMessage(jid, { image: { url: img }, caption: `🖼️ ${arg}` }); }
                    catch { await sock.sendMessage(jid, { text: '❌ No se pudo enviar la imagen' }); }
                    break;
                case 'meme':
                    await sock.sendMessage(jid, { text: '🔍 Buscando meme...' });
                    const mu = await getRandomMeme();
                    if (!mu) { await sock.sendMessage(jid, { text: '❌ No hay memes disponibles' }); break; }
                    await sock.sendMessage(jid, { image: { url: mu }, caption: 'Meme del día' });
                    break;
                case 'personalidad':
                    const t = arg.toLowerCase();
                    if (t === 'seria') { personalityMap.set(jid, 'seria'); await sock.sendMessage(jid, { text: '🧑‍💼 Modo serio activado' }); }
                    else if (t === 'pana') { personalityMap.set(jid, 'pana'); await sock.sendMessage(jid, { text: '😈 Modo pana activado' }); }
                    else await sock.sendMessage(jid, { text: '⚠️ Usa: #personalidad Seria o #personalidad Pana' });
                    break;
                case 'close':
                    if (!isGroup) { await sock.sendMessage(jid, { text: '❌ Solo funciona en grupos' }); break; }
                    const gMeta = await sock.groupMetadata(jid);
                    const cP = gMeta.participants.find(p => p.id === uid);
                    if (!cP?.admin) { await sock.sendMessage(jid, { text: '❌ Solo administradores' }); break; }
                    await sock.groupSettingUpdate(jid, 'announcement');
                    await sock.sendMessage(jid, { text: '🔒 Grupo cerrado: solo admins pueden enviar mensajes' });
                    break;
                case 'open':
                    if (!isGroup) { await sock.sendMessage(jid, { text: '❌ Solo funciona en grupos' }); break; }
                    const gMeta2 = await sock.groupMetadata(jid);
                    const oP = gMeta2.participants.find(p => p.id === uid);
                    if (!oP?.admin) { await sock.sendMessage(jid, { text: '❌ Solo administradores' }); break; }
                    await sock.groupSettingUpdate(jid, 'not_announcement');
                    await sock.sendMessage(jid, { text: '🔓 Grupo abierto: todos pueden enviar mensajes' });
                    break;
                default:
                    await sock.sendMessage(jid, { text: '❓ Comando no existente' });
            }
        } catch (err) {
            console.error('Error:', err);
            await sock.sendMessage(jid, { text: '❌ Error al procesar el comando' });
        }
    });
}

connectToWhatsApp();

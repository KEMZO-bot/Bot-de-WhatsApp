import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import ytdl from 'ytdl-core';
import ytSearch from 'yt-search';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import Pino from 'pino';

const logger = Pino({ level: 'silent' });

// ---------- CONFIGURACIÓN ----------
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PHONE_NUMBER = process.env.PHONE_NUMBER || '584129684011';

if (!OPENROUTER_API_KEY) {
    console.error('❌ ERROR: OPENROUTER_API_KEY no está configurada');
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

// ---------- IA (OpenRouter - GRATIS) ----------
async function generarRespuesta(prompt) {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: 'google/gemini-2.0-flash-001',
        messages: [
            { role: 'system', content: 'Eres un asistente amigable que habla español. Responde natural y corto. No menciones que eres IA.' },
            { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.7
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://bot-whatsapp-lckp.onrender.com',
            'X-Title': 'WhatsApp Bot'
        },
        timeout: 30000
    });
    return res.data.choices[0].message.content;
}

console.log('✅ IA OpenRouter configurada (gratis)');

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
        const s = ytdl(url, { filter: 'audioonly', quality: 'lowestaudio', highWaterMark: 1 << 14 });
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
        const s = ytdl(url, { quality: 'lowest', highWaterMark: 1 << 14 });
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
        if (r.data.hits?.length) return r.data.hits[0].largeImageURL || r.data.hits[0].webformatURL;
    } catch {}
    return `https://source.unsplash.com/800x600/?${encodeURIComponent(query)}`;
}

async function getRandomMeme() {
    try { const r = await axios.get('https://meme-api.com/gimme/memesesp', { timeout: 10000 }); if (r.data?.url) return r.data.url; } catch {}
    try { const r = await axios.get('https://meme-api.com/gimme/spanishmemes', { timeout: 10000 }); if (r.data?.url) return r.data.url; } catch {}
    try { const r = await axios.get('https://meme-api.com/gimme', { timeout: 10000 }); return r.data.url; } catch { return null; }
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
                    const respuesta = await generarRespuesta(`Te mencionaron en un grupo. Personalidad: ${p}. Mensaje: "${body}". Responde en español.`);
                    await sock.sendMessage(jid, { text: respuesta });
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
                    const respuesta = await generarRespuesta(`Eres un amigo. Personalidad: ${p}. Mensaje: "${body}". Responde en español.`);
                    await sock.sendMessage(jid, { text: respuesta });
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
                    await sock.sendMessage(jid, { text: '🔍 Buscando...' });
                    try {
                        const sr = await ytSearch(arg);
                        const v = sr.videos[0];
                        if (!v) { await sock.sendMessage(jid, { text: '❌ No encontré' }); break; }
                        if (v.seconds > 300) { await sock.sendMessage(jid, { text: `❌ *${v.title}* dura ${Math.floor(v.seconds/60)} min. Máximo 5 min.` }); break; }
                        await sock.sendMessage(jid, { text: `🎵 *${v.title}* - Descargando...` });
                        const ap = await downloadAudio(v.url);
                        await sock.sendMessage(jid, { audio: fs.readFileSync(ap), mimetype: 'audio/mp4', ptt: true });
                        fs.promises.unlink(ap).catch(() => {});
                    } catch (err) {
                        console.error('Error música:', err.message);
                        await sock.sendMessage(jid, { text: '❌ Error al descargar' });
                    }
                    break;
                case 'descargar':
                    if (!arg) { await sock.sendMessage(jid, { text: '⚠️ Pega el link' }); break; }
                    if (!ytdl.validateURL(arg)) { await sock.sendMessage(jid, { text: '❌ Solo YouTube' }); break; }
                    await sock.sendMessage(jid, { text: '📥 Descargando...' });
                    try {
                        const vp = await downloadVideo(arg);
                        await sock.sendMessage(jid, { video: fs.readFileSync(vp), caption: 'Aquí tienes' });
                        fs.promises.unlink(vp).catch(() => {});
                    } catch { await sock.sendMessage(jid, { text: '❌ Error' }); }
                    break;
                case 'hablar':
                    const pers = personalityMap.get(jid) || 'pana';
                    let prompt;
                    if (isGroup) {
                        const ctx = (messageStore.get(jid) || []).slice(-15).map(m => `${m.from}: ${m.body}`).join('\n');
                        prompt = `Amigo en grupo. Personalidad: ${pers}. Contexto:\n${ctx}\nResponde en español.`;
                    } else {
                        prompt = `Amigo personal. Personalidad: ${pers}. Mensaje: "${arg}". Responde en español.`;
                    }
                    try {
                        const respuesta = await generarRespuesta(prompt);
                        await sock.sendMessage(jid, { text: respuesta });
                    } catch (err) {
                        console.error('Error hablar:', err.message);
                        await sock.sendMessage(jid, { text: '❌ Error IA' });
                    }
                    break;
                case 'pin':
                    if (!arg) { await sock.sendMessage(jid, { text: '⚠️ Dime qué buscar' }); break; }
                    await sock.sendMessage(jid, { text: `🔍 Buscando imagen de "${arg}"...` });
                    const img = await searchImage(arg);
                    try { await sock.sendMessage(jid, { image: { url: img }, caption: `🖼️ ${arg}` }); }
                    catch { await sock.sendMessage(jid, { text: '❌ No se pudo enviar' }); }
                    break;
                case 'meme':
                    await sock.sendMessage(jid, { text: '🔍 Buscando meme...' });
                    const mu = await getRandomMeme();
                    if (!mu) { await sock.sendMessage(jid, { text: '❌ No disponible' }); break; }
                    await sock.sendMessage(jid, { image: { url: mu }, caption: 'Meme del día' });
                    break;
                case 'personalidad':
                    const t = arg.toLowerCase();
                    if (t === 'seria') { personalityMap.set(jid, 'seria'); await sock.sendMessage(jid, { text: '🧑‍💼 Modo serio' }); }
                    else if (t === 'pana') { personalityMap.set(jid, 'pana'); await sock.sendMessage(jid, { text: '😈 Modo pana' }); }
                    else await sock.sendMessage(jid, { text: '⚠️ Seria o Pana' });
                    break;
                case 'close':
                    if (!isGroup) { await sock.sendMessage(jid, { text: '❌ Solo grupos' }); break; }
                    const gMeta = await sock.groupMetadata(jid);
                    const cP = gMeta.participants.find(p => p.id === uid);
                    if (!cP?.admin) { await sock.sendMessage(jid, { text: '❌ Solo admins' }); break; }
                    await sock.groupSettingUpdate(jid, 'announcement');
                    await sock.sendMessage(jid, { text: '🔒 Grupo cerrado' });
                    break;
                case 'open':
                    if (!isGroup) { await sock.sendMessage(jid, { text: '❌ Solo grupos' }); break; }
                    const gMeta2 = await sock.groupMetadata(jid);
                    const oP = gMeta2.participants.find(p => p.id === uid);
                    if (!oP?.admin) { await sock.sendMessage(jid, { text: '❌ Solo admins' }); break; }
                    await sock.groupSettingUpdate(jid, 'not_announcement');
                    await sock.sendMessage(jid, { text: '🔓 Grupo abierto' });
                    break;
                default:
                    await sock.sendMessage(jid, { text: '❓ Comando no existente' });
            }
        } catch (err) {
            console.error('Error:', err);
            await sock.sendMessage(jid, { text: '❌ Error' });
        }
    });
}

connectToWhatsApp();

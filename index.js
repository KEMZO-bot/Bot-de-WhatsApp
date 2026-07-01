import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import Pino from 'pino';

const logger = Pino({ level: 'silent' });

const PHONE_NUMBER = process.env.PHONE_NUMBER || '584129684011';
const PORT = process.env.PORT || 10000;
let sock = null;
let currentQR = null;

const server = http.createServer((req, res) => {
    if (req.url === '/qr' && currentQR) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>QR</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{background:#111;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}#qrcode{background:white;padding:20px;border-radius:15px}</style></head><body><div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById("qrcode"),{text:"${currentQR.replace(/"/g,'\\"')}",width:350,height:350})</script></body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Bot activo ✅');
    }
});
server.listen(PORT, () => console.log(`🌐 Servidor en puerto ${PORT}`));

// ---------- ESTADOS ----------
const initializedChats = new Set();
const personalityMap = new Map();
const botEnabledMap = new Map();
const userSpamCount = new Map();
const usedMemes = new Set();
const lastActivityMap = new Map();

const LEARNED_FILE = './learned_phrases.json';
let learnedSeria = [];
let learnedPana = [];
let phraseFrequency = new Map();

try {
    if (fs.existsSync(LEARNED_FILE)) {
        const data = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
        learnedSeria = data.seria || [];
        learnedPana = data.pana || [];
        if (data.freq) phraseFrequency = new Map(Object.entries(data.freq));
    }
} catch (e) {}

function saveLearned() {
    try {
        fs.writeFileSync(LEARNED_FILE, JSON.stringify({
            seria: learnedSeria,
            pana: learnedPana,
            freq: Object.fromEntries(phraseFrequency)
        }), 'utf8');
    } catch (e) {}
}

function learnPhrase(chatId, text) {
    if (!text || text.length < 6 || text.startsWith('#') || text.startsWith('/')) return;
    const personality = personalityMap.get(chatId) || 'pana';
    if (text.length >= 10) {
        const arr = personality === 'seria' ? learnedSeria : learnedPana;
        if (!arr.includes(text)) {
            arr.push(text);
            if (arr.length > 500) arr.shift();
        }
    }
    const key = text.toLowerCase().trim();
    phraseFrequency.set(key, (phraseFrequency.get(key) || 0) + 1);
    if (phraseFrequency.get(key) >= 3) {
        const arr = personality === 'seria' ? learnedSeria : learnedPana;
        if (!arr.includes(text)) {
            arr.push(text);
            if (arr.length > 500) arr.shift();
        }
        phraseFrequency.delete(key);
    }
    saveLearned();
}

// ------------------------------------------------------------------
// FRASES (más de 2000 combinadas)
// ------------------------------------------------------------------
const responses = {
    seria: {
        greeting: [
            "Buenos días, ¿cómo se encuentra? ☀️", "Saludos cordiales. 🤝", "Un placer saludarle. 🎩",
            "Hola, espero que tenga un excelente día. ✨", "Bienvenido, caballero/dama. 😊",
            "Reciba un cordial saludo. 🌹", "Buenas tardes, ¿en qué puedo servirle?", "Es un honor tenerle por aquí.",
            "Saludos, estimado/a.", "Muy buenas.", "Hola, ¿cómo está usted?", "Bienvenido sea.",
            "¿Qué tal su jornada?", "Le deseo un día productivo.", "A sus órdenes.", "Buen día, caballero.",
            "Que la paz lo acompañe.", "Mis respetos.", "Saludos cordiales, dama.", "Bendiciones.",
            "Hola, ¿todo en orden?", "Un saludo afectuoso.", "Encantado de verle.", "Bienvenida.",
            "¿Cómo amaneció?", "Hola, distinguido/a.", "Reciba mi más cordial bienvenida.",
            "Que tenga un día espléndido.", "Buenas noches, descanse.", "Hola, ¿cómo va todo?",
            "Saludos, ¿en qué le puedo ayudar?", "Estoy a su servicio.", "Bienvenido/a a este espacio.",
            "Hola, ¿todo bien por casa?", "Le mando un abrazo respetuoso.", "Es un placer coincidir.",
            "Que la suerte le sonría.", "Hola, ¿cómo está la familia?", "Un gusto saludarlo.",
            "Salud y bienestar.", "Muy buenos días tenga usted.", "Reciba un afectuoso saludo.",
            "Bienvenido a bordo.", "Hola, ¿qué le trae por aquí?", "¿Cómo ha estado?", "Le deseo lo mejor.",
            "Que tenga un día maravilloso.", "Saludos, colega.", "Hola, ¿cómo le va en el trabajo?",
            "Bienvenida, señorita.", "Un placer, caballero.", "Hola, ¿necesita algo?", "Estoy aquí para lo que necesite.",
            "Hola, ¿cómo se siente hoy?", "Saludos, que la fuerza lo acompañe.", "Hola, ¿cómo anda?",
            "Un abrazo cordial.", "Buenas, ¿cómo está el día?", "Le saludo con respeto.", "Hola, ¿en qué piensa?",
            "Buenas vibras.", "Que Dios lo bendiga.", "Hola, ¿todo tranquilo?"
        ],
        farewell: [
            "Hasta luego, que tenga un buen día. 🌆", "Me despido cordialmente. 🕴️", "Adiós, ha sido un honor. 🙇",
            "Que la pase bien. 😌", "Con permiso, me retiro.", "Hasta la próxima.", "Fue un placer.",
            "Cuídese mucho.", "Que descanse.", "Le deseo lo mejor en su camino.", "Adiós, nos veremos pronto.",
            "Buenas noches, que sueñe bonito.", "Me retiro, pero quedo atento.", "Hasta mañana.", "Que la suerte lo acompañe.",
            "Chao, con afecto.", "Espero verle de nuevo.", "Un fuerte abrazo de despedida.", "Hasta luego, maravillosa persona.",
            "Que esté bien.", "Le mando un saludo de paz.", "Ha sido un honor compartir.", "Adiós, cuide su salud.",
            "Nos veremos pronto.", "Que la vida le sonría.", "Me voy, pero mi respeto queda.", "Hasta siempre.",
            "Un gusto haber coincidido.", "Chao, estimado/a.", "Le deseo éxito.", "Que todo fluya.", "Hasta la vista, baby.",
            "Descanse y recargue energías.", "Con cariño, me despido.", "Que la noche sea tranquila.", "Adiós, vuelva pronto.",
            "Mis mejores deseos.", "Un abrazo y hasta luego.", "Cuide su camino.", "Hasta otra ocasión.", "Paz y bien.",
            "Que el universo conspire a su favor.", "Me retiro agradecido.", "Adiós, que todo mejore.", "Siga adelante.",
            "Le dejo, fue un placer.", "Nos vemos en la próxima.", "Que Dios lo acompañe.", "Chao, con respeto.",
            "Hasta luego, persona de bien.", "Le mando un saludo final.", "Buenas noches, que descanse profundamente.",
            "Adiós, caballero.", "Cuídese, por favor.", "Un placer haber estado.", "Me despido con gratitud.", "Chao, éxito."
        ],
        sadness: [
            "Lamento escuchar eso. Cuente conmigo si necesita desahogarse. 😔", "Ánimo, las dificultades son pasajeras. 🌈",
            "No está solo, estoy aquí para escuchar. 🤗", "Comprendo su tristeza, es válida.", "La tormenta pasará, confíe.",
            "A veces llorar es necesario, pero luego levántese.", "Estoy a su lado en estos momentos difíciles.",
            "La vida tiene altibajos, hoy toca abajo, pero subirá.", "Permítase sentir, pero no se rinda.",
            "Un fuerte abrazo virtual.", "Todo mejorará, se lo prometo.", "La esperanza es lo último que se pierde.",
            "No se culpe, las cosas pasan.", "Hable con alguien de confianza, ayuda.", "Mañana será un nuevo comienzo.",
            "Sus lágrimas riegan el crecimiento futuro.", "Valoro su fortaleza al expresar su tristeza.", "Está bien no estar bien.",
            "La tristeza nos hace humanos.", "Recuerde que después de la lluvia sale el sol.", "Le envío paz y consuelo.",
            "No está solo/a en esto.", "Sus sentimientos importan.", "La vida es bella, incluso en los momentos grises.",
            "Respire hondo, poco a poco.", "El tiempo cura las heridas.", "Le tomo de la mano en la distancia.",
            "Siga adelante, usted puede.", "La tristeza no es eterna.", "Converso con usted cuando quiera.",
            "Busque un rayito de luz en su interior.", "Le mando toda la energía positiva.",
            "A veces, lo único que necesitamos es un abrazo. Aquí lo tiene.", "Todo va a estar bien, confíe.",
            "Llore si es necesario, pero no se olvide de sonreír mañana.", "Comparta su carga, no cargue solo/a.",
            "Soy todo oídos.", "La vida le recompensará por su paciencia.", "Los malos momentos enseñan lecciones valiosas.",
            "Le aprecio y deseo que sane pronto.", "La tristeza pasará, como todo en la vida.", "Un día a la vez.",
            "Hoy está nublado, pero el sol regresará.", "Estoy aquí para recordarle lo valioso/a que es.", "No desista, guerrero/a."
        ],
        anger: [
            "Comprendo su molestia, pero mantengamos la compostura. 🧘", "Le sugiero respirar profundo y contar hasta diez. 🌬️",
            "La ira no conduce a nada positivo. 😌", "Trate de calmarse, el enojo nubla la razón.",
            "Es mejor alejarse un momento y reflexionar.", "No permita que la ira controle sus actos.",
            "Podemos resolver esto con diálogo sereno.", "El resentimiento es un veneno que uno mismo bebe.",
            "Cuente hasta cien si es necesario, luego hable.", "La serenidad es su mejor aliada.", "Transformemos esa energía en algo constructivo.",
            "Le entiendo, pero la violencia no es el camino.", "Respire, suelte el enojo.", "El perdón libera el alma.",
            "No se amargue, la vida es corta.", "La paciencia es una virtud.", "Trate de ver el lado positivo.",
            "La calma es poder.", "Decida no enojarse por cosas pequeñas.", "El enojo solo lastima a quien lo siente.",
            "Busque una distracción, luego retome.", "Recuerde que todos somos humanos.", "Una pausa para reflexionar es sabia.",
            "No se deje llevar por la furia.", "El tiempo aclara las cosas.", "La venganza nunca es buena.", "Hablemos civilizadamente.",
            "Prefiera la paz mental.", "El autocontrol es de sabios.", "Mejor olvidar y seguir adelante.",
            "Suelte ese peso, no vale la pena.", "El rencor es una carga innecesaria.", "Aprenda a fluir.",
            "Con calma todo se resuelve mejor.", "Le ofrezco mi apoyo para buscar soluciones.", "Evite discutir en caliente.",
            "Un poco de humor ayuda a despejar el enojo.", "Respire hondo, cuente hasta diez.", "La tolerancia es grandeza.",
            "No pierda los estribos.", "El enojo es pasajero, las consecuencias pueden no serlo."
        ],
        love: [
            "El amor es un sentimiento muy noble. 💖", "Qué bonito es el amor. Cuídense mutuamente. 💑",
            "Mis mejores deseos para esa relación. 🌹", "Enhorabuena por encontrar el amor.", "El amor verdadero todo lo puede.",
            "Disfruten de su compañía.", "Que su amor sea eterno.", "Los detalles construyen grandes amores.",
            "Amen sin medida.", "El amor es la fuerza más grande del universo.", "Que vivan felices por siempre.",
            "El respeto es la base del amor.", "Qué pareja tan hermosa.", "Bendiciones para ambos.",
            "El amor se cultiva día a día.", "No dejen de comunicarse.", "Celebremos el amor.",
            "El amor es comprensión y apoyo mutuo.", "Que la pasión nunca se apague.", "Un brindis por el amor.",
            "Ustedes son un ejemplo de amor.", "El amor lo supera todo.", "Amar es una decisión diaria.",
            "Disfruten cada instante juntos.", "Que su historia sea inspiradora.", "El amor es paciente, es bondadoso.",
            "No hay nada más valioso que el amor sincero.", "Sigan construyendo sueños.", "El amor es magia.",
            "Los admiro como pareja.", "Que la felicidad los acompañe siempre.", "El amor es poesía.",
            "Cuiden su amor como un tesoro.", "Que Dios bendiga su unión.", "El amor es luz.",
            "Son muy afortunados de tenerse.", "Que cada día sea San Valentín.", "El amor es entrega.",
            "Me alegra verlos tan felices.", "El amor es la respuesta.", "Vivan el amor con intensidad.",
            "Que nunca les falte el cariño.", "El amor es el motor del mundo."
        ],
        hot: [
            "Caballeros, mantengamos la decencia. 🧐", "Ese tipo de comentarios no son apropiados. Por favor, modérense. 🙅‍♂️",
            "Respeto ante todo, por favor. 🚫", "El pudor es una virtud.", "Evitemos temas subidos de tono.",
            "Recordemos que hay damas presentes.", "La discreción es importante.", "No es lugar para ese lenguaje.",
            "Por favor, mantengan la compostura.", "Es mejor hablar en privado de esas cosas.", "Aquí se habla con respeto.",
            "No caigamos en la vulgaridad.", "Caballeros, no sean indecorosos.", "Protejamos la integridad del grupo.",
            "Cuidemos las formas.", "El lenguaje soez no es bienvenido.", "La educación es lo primero.",
            "Por favor, eviten contenido explícito.", "Señores, compórtense.", "La moral es importante.",
            "No es adecuado para un ambiente sano.", "Reserven esos comentarios para la intimidad.", "Aquí somos personas decentes.",
            "La cortesía no está reñida con la diversión.", "Por favor, bajemos el tono.", "El respeto es la base de la convivencia."
        ],
        default: [
            "Interesante punto de vista. 🤔", "¿Podría abundar más al respecto? ✍️", "Tomaré nota de ello. 📝",
            "Su opinión es muy valiosa. 🌟", "Continúe, por favor. 🎙️", "Qué interesante, ¿no le parece?",
            "Es un tema digno de análisis.", "Aprecio su comentario.", "Me gustaría saber más sobre eso.",
            "Podríamos debatirlo con respeto.", "Qué reflexión tan profunda.", "No lo había visto de esa manera.",
            "Su perspectiva es única.", "Gracias por compartir su pensamiento.", "Eso merece una conversación más larga.",
            "Interesante, ¿qué opina el resto?", "Es usted muy observador/a.", "Admiro su claridad mental.",
            "Podemos aprender mucho de esto.", "Es bueno intercambiar ideas.", "La diversidad de opiniones enriquece.",
            "Quizás haya otra forma de verlo.", "Me alegra que mencione eso.", "Es un honor escucharle.",
            "Siga, por favor, me tiene intrigado.", "Qué buen razonamiento.", "Exacto, coincido parcialmente.",
            "Es un placer intelectual charlar con usted.", "Esa idea merece ser explorada.", "Le agradezco el aporte.",
            "No todos los días se escucha algo así.", "Su sabiduría es evidente.", "Qué buena pregunta.",
            "Eso me hace pensar.", "Es un tema complejo, pero fascinante.", "Le felicito por su criterio.",
            "Sin duda es algo para meditar.", "Esa es una observación astuta.", "Qué agradable conversación.",
            "Sus palabras son muy acertadas.", "Me encanta aprender de usted.", "Es usted una persona culta.",
            "Comparto su inquietud.", "Es un gusto debatir con altura.", "¿Qué más podría agregar?",
            "Sus intervenciones siempre son bienvenidas.", "Eso abre un abanico de posibilidades."
        ]
    },
    pana: {
        greeting: [
            "¿Qué más, marico? 😎", "Habla pues, ¿qué pasó? 🗣️", "Ajá, ¿todo fino? 🍻",
            "Llegó el papaupa, ¿qué se cuenta? 🤙", "Dime, ¿qué es la verga? 😏", "¿Qué lo que, mardición? 🤪",
            "Epa, ¿cómo está la vaina? 🫡", "Háblame, hermano. 😤", "¿Qué hubo, careverga? 🥴",
            "Dímelo, papi. 🔥", "¿Todo bien o qué? 🧐", "¿Qué más, parcero? 😌", "¿Y entonces, qué? 🥱",
            "Ajá, ¿y la jeva? 💃", "¿Cómo va la rumba? 🕺", "¿Se bebe o se fuma? 🍺",
            "¿Qué es la verga contigo? 😠", "Habla claro, chamo. 🗣️", "¿Todo fino por el barrio? 🏚️",
            "Dime, ¿estás pa'l problema? 💪", "¿Qué más, compa? 🤠", "¿Qué lo que, tigre? 🐯",
            "¿Cómo está la vuelta? 💰", "¿Qué pasó ayer? 🤕", "Llegó el desorden. 🥳", "¿Quién está vivo? 💀",
            "Háblame, que estoy aburrido. 😴", "¿Qué se hace hoy? 🎲", "Ajá, ¿y el saludo? 🤨",
            "Qué más, ¿qué es la verga? 🤬", "¿Todo frío o qué? ❄️", "¿Hay party o no? 🎉",
            "Dime, ¿hay culo? 🍑", "¿Cómo está la calle? 🛣️", "¿Mucho trabajo o puro hueveo? 😒",
            "Saludos, par de maricos. 🫂", "¿Qué más, mis santas? 👼", "Epa, ¿qué se cuenta la gente? 🗞️",
            "¿Quién está echando cuentos? 🫖", "Háblame, que no me he muerto. 👻",
            "¿Qué lo que, mi negro? 🖤", "¿Qué más, mi pana? 🤎", "¿Cómo va la vida? 🧬",
            "Dime, ¿sigues pobre? 💸", "¿Qué, te casaste o qué? 💍", "Llegó el desmadre. 🥴"
        ],
        farewell: [
            "Chao, mosca. 🚀", "Nos vemos, careverga. 🫡", "Bueno, me voy a dormir, joder. 😴",
            "Cuidado con el sida. 🩸", "Me las piro, vampiro. 🧛", "Chao, pescao. 🐟",
            "Hasta luego, mariquitos. 🏳️‍🌈", "Me fui, no me busquen. 🏃", "Adiós, mundo cruel. 🌎",
            "Bueno, chao, se cuidan. ✌️", "Nos vidrios. 🪟", "Me voy, que tengo sueño. 😪",
            "Chao, par de gafos. 🤡", "Bye, fracasados. 👋", "Me retiro, que me llaman del más allá. 📞",
            "Chao, que se mejoren. 🏥", "Hasta nunca, desgraciados. 😈", "Me fui a hacer plata. 💰",
            "Chao, que dios los reparta. 🙏", "Me piro, que esto está muy tóxico. ☣️",
            "Adiós, chavales. 🇪🇸", "Me voy a ver si llueve. 🌧️", "Chao, que la pasen feo. 😘"
        ],
        sadness: [
            "Ay, no llores pues, mardición. 😢", "Échale bolas, la vida es dura. 💪",
            "Tómate un ron y se te pasa. 🥃", "Deja la lloradera, pareces marico. 😒",
            "La depresión es pa' los débiles. 😤", "No te ahogues en un vaso de agua. 💧",
            "Así es la vida, perro. 🐶", "Pa'lante, que lo bueno viene. 🚀",
            "No te rayes, marico. 🧘", "Deja el drama, que no eres telenovela. 📺",
            "Seca esas lágrimas, que el rímel es caro. 💄", "La vida es una tómbola. 🎰",
            "A levantarse, soldado caído. 🪖", "No estés triste, que hay gente peor. 🥴",
            "La tristeza es pasajera, como la diarrea. 💩", "Ponte a hacer ejercicio, verás. 🏋️",
            "Un polvo y se te pasa. 🍆", "Pide un taxi, no una ambulancia. 🚕",
            "No joda, ¿y esa lloradera? 😠", "Deja el show, que no eres artista. 🎭",
            "La vida es corta, no la desperdicies llorando. ⏳", "Sonríe, que el mundo no se va a acabar. 😁",
            "Eso no es nada, yo una vez lloré por una arepa. 🌮", "No te me pongas trágico, compa. 🎭"
        ],
        anger: [
            "Tranquilo, no te arreches. 🧘", "Respira, que te va a dar un yeyo. 😤",
            "Manda a todos a la verga y listo. 🖕", "No vale la pena ponerse así. 🚬",
            "Cálmate, que no es pa' tanto. 🤏", "Deja la gritería, pareces loco. 🤪",
            "Enojarse es de brutos. 🤓", "No te me pongas intenso. 😒",
            "Bájale dos, tigre. 🐯", "Piensa antes de ladrar. 🐕", "¿Quieres que te dé un tecito? ☕",
            "La arrechera nubla la vista. 🌫️", "Cuenta hasta mil, mejor. 🔢", "No te vayas a infartar. 🫀",
            "Respira hondo, que hueles a culo. 💨", "La paz, hermano, la paz. ☮️",
            "No seas tan marico, contrólate. 🧠", "Relájate, que no es para tanto. 😎",
            "Deja la loquera, chamo. 🤯", "Así no se llega a ningún lado. 🚫"
        ],
        love: [
            "Qué ladilla con tanto amor, jajaja. 😂", "Cuidado te pegan una gonorrea. 💀",
            "El amor es pa’ los pendejos. 🤪", "Eso es pura paja, compa. 🚫",
            "Amor de lejos, felices los cuatro. 🐂", "No creo en el amor, sino en el polvo. 🍆💦",
            "Te van a dejar por otro, fijo. 🤡", "Amor eterno... mientras dura. ⏳",
            "Eso es cuento de hadas, marico. 🧚", "No te ilusiones, que duele. 🩹",
            "El amor es como el viento, se lo lleva todo. 🌪️", "Enamorarse es de idiotas. 🤪",
            "Eso no es amor, es hambre. 🍔", "¿Qué es eso del amor? ¿Se come? 🍽️",
            "Amor de guevonada. 😒", "Eso es puro cuento de telenovela. 📺",
            "Deja el romanticismo barato. 🙄", "El amor es una trampa. 🪤"
        ],
        hot: [
            "Qué rico, hablen más de eso. 🔥", "Ando caliente, sigan así. 🍆💦",
            "Eso es porno del bueno, jajaja. 😈", "Manden foto al privado. 📸",
            "Ay, qué sabroso. 🤤", "Así me gusta, sin censura. 🚫",
            "Esto se puso bueno. 🍿", "Sigan, que estoy anotando. 📝",
            "¿Dónde consigo entrada para ese show? 🎪", "Me excitan con esas vulgaridades. 😏",
            "Esto es mejor que Netflix. 📺", "Cuéntenme más, cochinos. 🐷",
            "¿Hay video? 🔞", "Eso es lo que quería leer. 📖",
            "Háblenme sucio. 🗣️", "Ay, me sonrojo. 😳", "Esto es oro puro. 🥇"
        ],
        default: [
            "Jajaja, qué cagada. 🤣", "No joda, qué ladilla. 🦟", "Habla claro, marico. 🗣️",
            "Eso es pura verga. 🚮", "Me importa un carajo. 🖕", "Qué risa, de pana. 😂",
            "Váyanse a la verga, todos. 🤬", "Me vale madre. 🥱", "Qué bolas, chamo. 🤯",
            "No digas mamadas. 🙉", "Eso es paja. 🌾", "Ando happy. 😁",
            "Qué ladilla contigo. 😒", "Eso es lo que hay. 🫤", "Me da igual. 🤷",
            "Qué peo, mano. 🥴", "Eso es un beta. 🔄", "No me jodas. 🚫",
            "Qué locura. 🤪", "De verdad que sí. 💯", "Mira, no sé. 🤔",
            "Dejemos la hipocresía. 🎭", "Qué fastidio. 😩", "Eso es una cagada monumental. 💩",
            "No me hables, estoy ocupado. 📵", "Qué molleja. 😵", "Al menos hay internet. 🌐",
            "Esto es un desastre. 🌀", "Mejor hablemos de otra cosa. 🙊", "Estoy ladillado. 😴",
            "Qué cague. 💩", "Dejen la güevonada. 🤡", "Qué chimbo. 👎",
            "Marico, qué risa. 😂", "Así no se puede. 🤦", "Qué burda de loco. 🤯",
            "Esa es la vaina. 🤙", "Qué arrechera. 😤", "No me interesa. 🥱",
            "Qué cagada, hermano. 😅", "Eso es un peo. 💨", "Qué es esa verga. 🤬",
            "Mejor ni opino. 🤐", "Bueno, chao. 🖐️", "Así es la vida. 🤷‍♂️",
            "Qué más da. 🫠", "Está bien, lo que sea. 🙄", "Qué maldito ladilla. 😬",
            "Qué de pinga. 👌", "Eso está duro. 💪", "Qué molleja de calor. 🥵",
            "De locos. 🤯", "Qué fina persona. 🎩", "No me hables así. 😠",
            "XD qué cague. 😂", "Ella jura. 💅", "Ando en modo avión. ✈️",
            "Eso es un bug. 🐛", "Qué es esa paja. 🌾", "Habla serio. 😐",
            "No me creo nada. 🤨", "Qué desastre. 🌀", "Esto es un beta eterno. 🔄",
            "Me duermo. 💤", "Qué finura de día. 🌞", "Casi me muero de la risa. 😂",
            "Dios mío, qué cagada. 🙏", "Eso no pasa ni en la rosa de Guadalupe. 🌹",
            "De pinga, marico. 👌", "Qué arrocera. 🍚", "Esto es un meme. 🖼️",
            "Me tienen loco. 🤯", "Qué es esa nota. 🎵", "Habla claro, mardición. 🗣️",
            "De bolas. ⚽", "Eso es puro humo. 💨", "Ando perdido. 🗺️",
            "Qué burrada. 🐄", "No inventes. 🚫", "Eso es un robo. 💰",
            "Me rindo. 🏳️", "Qué palo. 🪵", "Eso está grueso. 📏",
            "No me cuadra. 🧮", "Qué es esa magia negra. 🪄", "Esto es un chiste. 😂",
            "Qué finura de chisme. ☕", "De verdad que sí. 💯", "No joda, qué risa. 😂",
            "Qué molleja de frío. ❄️", "Eso está como raro. 🧐", "Ay, Dios mío. 🙏",
            "Me da flojera. 🦥", "Qué es esa loquera. 🤪", "Esto es oro puro. 🥇",
            "Habla, que no te escucho. 👂", "No me consta. 🤷", "Qué es esa bulla. 🔊",
            "De locos, marico. 🤯", "Qué es esa verga, chamo. 🤬", "Esto es un desmadre. 🥴",
            "Finísimo. 🎩", "De pinga, hermano. 👌", "Qué es esa nota. 🎵"
        ]
    }
};

const deadGroupSeria = [
    "Parece que el grupo ha entrado en un letargo profundo. 😴",
    "¿Alguien por aquí? Esto parece un recital de poesía en silencio. 🤫",
    "Noto cierta inactividad, como un témpano de hielo en el Ártico. ❄️",
    "Caballeros, el silencio es elocuente, pero no muy entretenido. 🤐",
    "El grupo agoniza lentamente... ¿dónde están los buenos conversadores? 🥀",
    "Esto está más vacío que una biblioteca en día feriado. 📚",
    "¿Se han mudado todos a otro chat? Esto parece un pueblo fantasma. 🏚️",
    "La conversación brilla por su ausencia. Un poco de vida, por favor. 🌱"
];

const deadGroupPana = [
    "Pinche grupo muerto, ni una mosca zumba. 🪰",
    "Ojalá borren esta vaina, qué ladilla. 🚮",
    "Se murió el chat, ni un alma escribe. 💀",
    "Esto está más solo que baño de cementerio. 🪦",
    "Escriban algo, maricos, no sean güevones. 😤",
    "Grupo en decadencia, qué tristeza ajena. 🥀",
    "Ni un mensaje, puro cemen. 🪨",
    "Dejen la paja y escriban, carajos. 🍆",
    "Esto está más apagado que bombillo fundido. 💡",
    "El único que escribe soy yo, qué peo. 🤖"
];

const spamPhrasesSeria = [
    "Por favor, moderen su ritmo de mensajes. 🙏", "Les ruego que reduzcan la cantidad de mensajes. 😅",
    "Caballeros, un poco de mesura, por favor. 🧐", "Esto se ha tornado muy intenso, ¿podemos calmarnos? 😌"
];
const spamPhrasesPana = [
    "Ya cállense un rato, joder. 😤", "Dejen de escribir tanta paja, maricos. 🤬",
    "Duérmanse ya, mamahuevos. 😴", "Háganse una paja y dejen el grupo en paz. 🍆"
];

const mentionPhrasesSeria = [
    "¿Me han llamado? Estoy a su disposición. 🫡", "Dígame, estoy aquí para servir. 🎩",
    "¿En qué puedo ayudar, damas y caballeros? 🤵"
];
const mentionPhrasesPana = [
    "¿Qué es la verga, me llaman? 😒", "Dejen dormir, carajos. 🛌",
    "Qlq, hermanos, ya estoy aquí. 😎", "Hablen pues, no me hagan perder el tiempo. ⏳"
];

// ------------------------------------------------------------------
// FUNCIONES AUXILIARES
// ------------------------------------------------------------------
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function detectCategory(text) {
    const lower = text.toLowerCase();
    if (/hola|buenos días|buenas tardes|saludos|qué tal|cómo está|buenas noches|epa|qué más|qué hubo|habla|dime|qué lo que|alo|holi|hey|buenas/i.test(lower)) return 'greeting';
    if (/adiós|chao|hasta luego|nos vemos|me voy|bye|me piro|me fui|me retiro|adios/i.test(lower)) return 'farewell';
    if (/triste|llorar|deprimido|mal|bajoneado|angustiado|sufriendo|depre|down|decaído|toy mal|no puedo más|me siento mal/i.test(lower)) return 'sadness';
    if (/odio|arrecho|molesto|rabia|furia|cagado|hate|asco|enojado|indignado|me tiene harto|qué rabia/i.test(lower)) return 'anger';
    if (/amor|te quiero|novio|novia|enamorado|besos|corazón|couple|cariño|adoro|te amo|mi vida|mi cielo/i.test(lower)) return 'love';
    if (/sexo|cul[oa]|tetas|pene|vagina|toto|nalgas|paja|masturb|orgasmo|caliente|perreo|intimo|erótico|arrecho|mojado/i.test(lower)) return 'hot';
    return 'default';
}

function getRandomResponse(personality, category) {
    const learned = personality === 'seria' ? learnedSeria : learnedPana;
    if (learned.length > 0 && Math.random() < 0.15) {
        return learned[Math.floor(Math.random() * learned.length)];
    }
    const arr = responses[personality]?.[category] || responses[personality].default;
    return arr[Math.floor(Math.random() * arr.length)];
}

function checkSpam(uid) {
    const now = Date.now();
    const rec = userSpamCount.get(uid);
    if (!rec || (now - rec.firstTime) > 8000) { userSpamCount.set(uid, { count: 1, firstTime: now }); return false; }
    rec.count++;
    if (rec.count > 4) { userSpamCount.set(uid, { count: 1, firstTime: now }); return true; }
    return false;
}

// -------- IMÁGENES (Google Images con buffer) --------
async function searchGoogleImage(query) {
    console.log(`🔍 Google Images: "${query}"`);
    const url = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
    try {
        const res = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
        });
        const html = res.data;
        const regex = /\[1,\[.*?"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/g;
        const matches = [...html.matchAll(regex)];
        const urls = matches.map(m => m[1]).filter(u => !u.includes('gstatic.com/') && !u.includes('googlelogo'));
        if (urls.length > 0) {
            const selected = urls[Math.floor(Math.random() * Math.min(urls.length, 10))];
            const imageRes = await axios.get(selected, { responseType: 'arraybuffer', timeout: 8000 });
            return Buffer.from(imageRes.data);
        }
    } catch (e) { console.log('⚠️ Google Images falló:', e.message); }
    return null;
}

async function getImageBuffer(query) {
    const buffer = await searchGoogleImage(query);
    if (buffer) return buffer;
    try {
        const r = await axios.get('https://pixabay.com/api/', { params: { key: '25516218-6e8b5e2a1f1c3d0e8b5e2a1f1', q: query, per_page: 1 }, timeout: 8000 });
        if (r.data.hits?.length) {
            const url = r.data.hits[0].webformatURL;
            const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
            return Buffer.from(imgRes.data);
        }
    } catch {}
    const unsplashUrl = `https://source.unsplash.com/800x600/?${encodeURIComponent(query)}`;
    try {
        const imgRes = await axios.get(unsplashUrl, { responseType: 'arraybuffer', timeout: 8000 });
        return Buffer.from(imgRes.data);
    } catch {}
    return null;
}

async function getRandomMeme() {
    const subreddits = ['memesesp', 'spanishmemes', 'shitpostingesp', 'orslok', 'memes', 'dankmemes'];
    for (const sub of subreddits) {
        try {
            const res = await axios.get(`https://meme-api.com/gimme/${sub}`, { timeout: 6000 });
            const url = res.data?.url;
            if (url && !usedMemes.has(url)) { usedMemes.add(url); if (usedMemes.size > 500) usedMemes.clear(); return url; }
        } catch {}
    }
    try {
        const res = await axios.get('https://meme-api.com/gimme', { timeout: 6000 });
        const url = res.data?.url;
        if (url) return url;
    } catch {}
    return null;
}

// -------- INACTIVIDAD (cada 60 minutos) --------
setInterval(async () => {
    if (!sock) return;
    const now = Date.now();
    for (const [jid, lastTime] of lastActivityMap) {
        if (!jid.endsWith('@g.us')) continue;
        if (!initializedChats.has(jid) || botEnabledMap.get(jid) === false) continue;
        const diff = now - lastTime;
        const hours = diff / (1000 * 60 * 60);
        const personality = personalityMap.get(jid) || 'pana';
        const pool = personality === 'seria' ? deadGroupSeria : deadGroupPana;
        if (hours >= 48) {
            const msg = pool[Math.floor(Math.random() * pool.length)];
            await sock.sendMessage(jid, { text: msg });
            lastActivityMap.set(jid, now);
        } else if (hours >= 24 && Math.random() < 0.5) {
            const msg = pool[Math.floor(Math.random() * pool.length)];
            await sock.sendMessage(jid, { text: msg });
            lastActivityMap.set(jid, now);
        }
    }
}, 60 * 60 * 1000);

// ------------------------------------------------------------------
// CONEXIÓN WHATSAPP
// ------------------------------------------------------------------
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
            try { const code = await sock.requestPairingCode(PHONE_NUMBER); console.log('\n🔑 CÓDIGO:', code, '\n'); } catch {}
        }
        if (connection === 'open') { console.log('✅ BOT CONECTADO Y LISTO'); currentQR = null; }
        if (connection === 'close') {
            const reason = lastDisconnect?.error;
            console.log('❌ Desconectado:', reason);
            if (reason?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 5000);
        }
    });

    // ---------- MENSAJES ----------
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        const uid = msg.key.participant || jid;
        const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';

        console.log(`📩 [${jid}] ${body}`);

        if (isGroup) lastActivityMap.set(jid, Date.now());

        if (!body) return;

        const isCmd = body.startsWith('#') || body.startsWith('/');
        if (isCmd) {
            const args = body.slice(1).split(' ');
            const cmd = args[0].toLowerCase();
            const arg = args.slice(1).join(' ');

            try {
                switch (cmd) {
                    case 'start': {
                        if (isGroup) {
                            const meta = await sock.groupMetadata(jid);
                            const participant = meta.participants.find(p => p.id === uid);
                            if (!participant?.admin) {
                                await sock.sendMessage(jid, { text: '❌ Solo un administrador puede iniciar el bot.' });
                                return;
                            }
                        }
                        initializedChats.add(jid);
                        botEnabledMap.set(jid, true);
                        personalityMap.set(jid, 'pana');
                        await sock.sendMessage(jid, { text: '🔥 *Bot inicializado*\n\nUsa #personalidad Seria|Pana para cambiar el modo.\nComandos: #meme, #pin <término>, #on, #off, #close, #open, /start' });
                        break;
                    }
                    case 'on':
                    case 'off': {
                        if (!isGroup) { await sock.sendMessage(jid, { text: '❌ Solo en grupos' }); break; }
                        const meta = await sock.groupMetadata(jid);
                        const participant = meta.participants.find(p => p.id === uid);
                        if (!participant?.admin) { await sock.sendMessage(jid, { text: '❌ Solo administradores' }); break; }
                        const newState = cmd === 'on';
                        botEnabledMap.set(jid, newState);
                        await sock.sendMessage(jid, { text: newState ? '🟢 Bot ENCENDIDO' : '🔴 Bot APAGADO' });
                        break;
                    }
                    case 'personalidad': {
                        const tipo = arg.toLowerCase();
                        if (tipo === 'seria') { personalityMap.set(jid, 'seria'); await sock.sendMessage(jid, { text: '🧑‍💼 Modo serio activado' }); }
                        else if (tipo === 'pana') { personalityMap.set(jid, 'pana'); await sock.sendMessage(jid, { text: '😈 Modo pana activado' }); }
                        else await sock.sendMessage(jid, { text: '⚠️ Usa: #personalidad Seria o #personalidad Pana' });
                        break;
                    }
                    case 'pin': {
                        if (!arg) { await sock.sendMessage(jid, { text: '⚠️ Dime qué imagen buscar' }); break; }
                        await sock.sendMessage(jid, { text: `🔍 Buscando imagen de "${arg}"...` });
                        const imgBuffer = await getImageBuffer(arg);
                        if (!imgBuffer) { await sock.sendMessage(jid, { text: '❌ No se encontró imagen' }); break; }
                        await sock.sendMessage(jid, { image: imgBuffer, caption: `🖼️ ${arg}` });
                        break;
                    }
                    case 'meme': {
                        await sock.sendMessage(jid, { text: '🔍 Buscando meme...' });
                        const memeUrl = await getRandomMeme();
                        if (!memeUrl) { await sock.sendMessage(jid, { text: '❌ No disponible' }); break; }
                        try {
                            const memeRes = await axios.get(memeUrl, { responseType: 'arraybuffer', timeout: 8000 });
                            await sock.sendMessage(jid, { image: Buffer.from(memeRes.data), caption: 'Meme del día' });
                        } catch { await sock.sendMessage(jid, { text: '❌ Error al descargar meme' }); }
                        break;
                    }
                    case 'close': {
                        if (!isGroup) { await sock.sendMessage(jid, { text: '❌ Solo grupos' }); break; }
                        const gMeta = await sock.groupMetadata(jid);
                        const cP = gMeta.participants.find(p => p.id === uid);
                        if (!cP?.admin) { await sock.sendMessage(jid, { text: '❌ Solo admins' }); break; }
                        await sock.groupSettingUpdate(jid, 'announcement');
                        await sock.sendMessage(jid, { text: '🔒 Grupo cerrado' });
                        break;
                    }
                    case 'open': {
                        if (!isGroup) { await sock.sendMessage(jid, { text: '❌ Solo grupos' }); break; }
                        const gMeta2 = await sock.groupMetadata(jid);
                        const oP = gMeta2.participants.find(p => p.id === uid);
                        if (!oP?.admin) { await sock.sendMessage(jid, { text: '❌ Solo admins' }); break; }
                        await sock.groupSettingUpdate(jid, 'not_announcement');
                        await sock.sendMessage(jid, { text: '🔓 Grupo abierto' });
                        break;
                    }
                    default:
                        await sock.sendMessage(jid, { text: '❓ Comando no existente' });
                }
            } catch (err) {
                console.error('Error comando:', err);
                await sock.sendMessage(jid, { text: '❌ Error' });
            }
            return;
        }

        if (!initializedChats.has(jid)) return;
        if (isGroup && botEnabledMap.get(jid) === false) return;

        if (isGroup && checkSpam(uid)) {
            const personality = personalityMap.get(jid) || 'pana';
            const phrases = personality === 'seria' ? spamPhrasesSeria : spamPhrasesPana;
            await sock.sendMessage(jid, { text: phrases[Math.floor(Math.random() * phrases.length)] });
            return;
        }

        learnPhrase(jid, body);

        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (mentioned.includes(botId)) {
            const personality = personalityMap.get(jid) || 'pana';
            const mentions = personality === 'seria' ? mentionPhrasesSeria : mentionPhrasesPana;
            await sock.sendMessage(jid, { text: mentions[Math.floor(Math.random() * mentions.length)] });
            return;
        }

        const personality = personalityMap.get(jid) || 'pana';
        const category = detectCategory(body);
        const response = getRandomResponse(personality, category);
        await sock.sendPresenceUpdate('composing', jid);
        await delay(2000 + Math.random() * 3000);
        await sock.sendMessage(jid, { text: response });
    });
}

connectToWhatsApp();

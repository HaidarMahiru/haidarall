const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const cheerio = require('cheerio');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Konfigurasi Multer (Filter khusus Image Only)
const upload = multer({ 
    dest: os.tmpdir(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Hanya boleh upload file gambar!'), false);
        }
    }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.send('Server Running. Upload index.html to public folder.');
});

// --- CLIENT AXIOS GLOBAL ---
const axiosClient = axios.create({
    timeout: 25000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' }
});

// --- HEADERS LENGKAP FSMVID ---
const FSM_HEADERS = {
    "Authority": "fsmvid.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Content-Type": "application/json",
    "Origin": "https://fsmvid.com",
    "Referer": "https://fsmvid.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
};

// Helper Upload ke Catbox
async function uploadToCatbox(filePath) {
    if (!fs.existsSync(filePath)) throw new Error("File tidak ditemukan");
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    formData.append('userhash', '');
    formData.append('fileToUpload', fs.createReadStream(filePath));
    try {
        const response = await axiosClient.post('https://catbox.moe/user/api.php', formData, { 
            headers: formData.getHeaders() 
        });
        return response.data;
    } catch (error) { throw new Error("Gagal upload ke Catbox"); }
}

function safeDelete(filePath) {
    try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } 
    catch (err) { console.error("Delete err:", err.message); }
}

// ==========================================
// 1. AIO DOWNLOADER (Fix Filename & Ext)
// ==========================================
app.post('/api/download', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ status: false, message: "URL required" });

    let currentPlatform = "youtube";
    if (url.includes("facebook") || url.includes("fb.watch")) currentPlatform = "facebook";
    else if (url.includes("tiktok")) currentPlatform = "tiktok";
    else if (url.includes("instagram")) currentPlatform = "instagram";
    else if (url.includes("twitter") || url.includes("x.com")) currentPlatform = "twitter";

    try {
        const response = await axios.post("https://fsmvid.com/api/proxy", {
            url: url, platform: currentPlatform, isHomepage: true
        }, { headers: FSM_HEADERS, timeout: 9000 });

        if (!response.data || response.data.status !== 'success') {
            return res.json({ status: false, message: "Gagal mengambil data." });
        }

        // Sanitasi Title untuk nama file
        let rawTitle = response.data.title || "video_download";
        let safeTitle = rawTitle.replace(/[^\w\s\-\.]/gi, '').substring(0, 100).trim() || "video";

        const result = {
            title: safeTitle,
            thumbnail: response.data.thumbnail || "",
            platform: currentPlatform,
            downloads: (response.data.medias || []).map(m => {
                // Logic Fix Extension
                let ext = m.extension;
                let isAudio = m.type === 'audio';
                
                // Paksa jadi mp3 jika tipe audio, jangan mp4.mp3
                if (isAudio) ext = 'mp3'; 
                
                let label = isAudio ? `🎵 Audio (${ext})` : `🎬 ${m.quality} (${ext})`;
                if(currentPlatform==='youtube' && !isAudio) label += (m.audio_available!==false && m.is_audio!==false) ? " 🔊" : " 🔇";

                return { 
                    label, 
                    url: m.url, 
                    type: m.type, 
                    ext: ext, // Kirim ext bersih ke frontend
                    filename: `${safeTitle}.${ext}`, // Kirim nama file lengkap
                    size: m.contentLength ? (parseInt(m.contentLength)/(1024*1024)).toFixed(1)+"MB" : "?" 
                };
            })
        };
        res.json(result);
    } catch (error) { 
        res.status(500).json({ status: false, message: "Server Error / Timeout" }); 
    }
});

app.get('/api/stream', async (req, res) => {
    try {
        const { url, name } = req.query;
        if(!url) return res.status(400).send("No URL");

        // Request stream
        const response = await axios({ 
            method: 'GET', url: url, responseType: 'stream', 
            headers: FSM_HEADERS, timeout: 20000
        });
        
        // Gunakan nama file dari parameter query (yang dikirim dari frontend hasil /api/download tadi)
        // Jika tidak ada, fallback ke video.mp4
        const filename = name ? name : 'media.mp4';
        
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        response.data.pipe(res);
    } catch (e) { res.status(500).send("Gagal Stream."); }
});

// ==========================================
// 2. TOOLS (Image Only, NGL Link Only)
// ==========================================

// Transcribe & Summarize (Tetap ada)
app.post('/api/transcribe', async (req, res) => {
    try { 
        const r = await axiosClient.get(`https://api.nexray.web.id/tools/yt-transcribe?url=${encodeURIComponent(req.body.url)}`);
        res.json(r.data.status ? {success:true, transcript:r.data.data.transcript} : {success:false, message:"Gagal"}); 
    } catch(e){ res.status(500).json({success:false}); }
});

app.post('/api/summarize', async (req, res) => {
    try {
        const r = await axiosClient.get(`https://api.nexray.web.id/tools/v1/youtube-summarize?url=${encodeURIComponent(req.body.url)}`);
        if(r.data.status && r.data.result) {
            const txtUrl = r.data.result.url;
            const textResponse = await axios.get(txtUrl); 
            res.json({ success: true, summary: textResponse.data });
        } else { res.json({ success: false, message: "Gagal summarize." }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

// Music Generator (Tetap ada)
app.post('/api/music', async (req, res) => {
    try {
        const r = await axiosClient.get(`https://api.nexray.web.id/ai/suno?prompt=${encodeURIComponent(req.body.prompt)}`);
        res.json(r.data.status ? {success:true, result:r.data.result} : {success:false});
    } catch(e) { res.status(500).json({success:false}); }
});

// Tools Image (RemoveBG, Upscale, dll) - STRICT IMAGE ONLY
app.post('/api/tools/image', (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        next();
    });
}, async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "File wajib gambar!" });
    
    try {
        const catboxUrl = await uploadToCatbox(req.file.path); 
        safeDelete(req.file.path);
        const { type, resolution } = req.body;
        
        let apiUrl = `https://api.nexray.web.id/tools/${type}?url=${encodeURIComponent(catboxUrl)}`;
        if (type === 'removebg') apiUrl = `https://api.nexray.web.id/tools/v1/removebg?url=${encodeURIComponent(catboxUrl)}`;
        if (type === 'dewatermark') apiUrl = `https://api.nexray.web.id/tools/v1/dewatermark?url=${encodeURIComponent(catboxUrl)}`;
        if (type === 'upscale') apiUrl += `&resolusi=${resolution||'2'}`;
        
        const r = await axiosClient.get(apiUrl, { responseType:'arraybuffer' });
        const b64 = Buffer.from(r.data).toString('base64');
        res.json({success:true, image:`data:${r.headers['content-type']};base64,${b64}`});
    } catch(e) { safeDelete(req.file?.path); res.status(500).json({success:false, message: "Gagal proses gambar."}); }
});

// NGL Spam - LINK ONLY
app.post('/api/tools/ngl', async (req, res) => {
    const { url, message, amount } = req.body;
    
    // Validasi Link NGL
    if (!url || !url.includes('ngl.link')) {
        return res.json({ status: false, message: "Harap masukkan Link NGL yang valid (https://ngl.link/username)" });
    }

    try {
        const targetUrl = `https://api.nexray.web.id/tools/spamngl?url=${encodeURIComponent(url)}&pesan=${encodeURIComponent(message)}&jumlah=${amount}`;
        const r = await axiosClient.get(targetUrl); 
        res.json(r.data);
    } catch (e) { res.status(500).json({ status: false, message: "Gagal Spam." }); }
});

// SimiSimi
app.post('/api/simi', async (req, res) => {
    const { text } = req.body;
    const prompt = `Role: SimiSimi (Lucu, Gaul, Indo).\nUser: ${text}\nSimi:`;
    try {
        const r = await axiosClient.get(`https://api.nexray.web.id/ai/gemini?text=${encodeURIComponent(prompt)}`);
        res.json({success:true, reply: r.data.result || "..."}); 
    } catch(e){ res.json({success:true, reply:"..."}); }
});

// QURAN & MAIL (Tetap Sama)
app.get('/api/quran/list', async (req, res) => { try { const { data } = await axiosClient.get('https://tafsirweb.com/'); const $ = cheerio.load(data); const list = []; $('a').each((i, el) => { const href = $(el).attr('href'); if (href && href.includes('surat') && href.includes('.html')) list.push({ name: $(el).text().trim(), url: href }); }); res.json(list); } catch (e) { res.status(500).json({ error: "Error" }); } });
app.post('/api/quran/detail', async (req, res) => { try { const { data } = await axiosClient.get(req.body.url); const $ = cheerio.load(data); let verses = [], current = { ayat: 0, arab: "", artinya: "" }; $('.entry-content p, article p').each((i, el) => { let text = $(el).text().trim(); if (/[\u0600-\u06FF]/.test(text)) { if (current.arab) { verses.push({ ...current }); current = { ayat: 0, arab: "", artinya: "" }; } current.arab = text; } else if (text.length > 10 && !text.toLowerCase().includes('latin')) { current.artinya = text.replace(/^Artinya\s*[:]\s*/i, ''); } }); if (current.arab) verses.push(current); res.json(verses); } catch (e) { res.status(500).json({ error: "Error" }); } });

const TEMP_MAIL_HEADERS = { 'Content-Type': 'application/json', 'Application-Name': 'web', 'Application-Version': '4.0.0', 'X-CORS-Header': 'iaWg3pchvFx48fY', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
app.get('/api/tempmail/create', async (req, res) => { try { const r = await axios.post('https://api.internal.temp-mail.io/api/v3/email/new', { min_name_length: 10, max_name_length: 10 }, { headers: TEMP_MAIL_HEADERS }); res.json(r.data); } catch(e){ res.status(500).json({error:"Gagal"}); } });
app.get('/api/tempmail/inbox/:email', async (req, res) => { try { const r = await axios.get(`https://api.internal.temp-mail.io/api/v3/email/${req.params.email}/messages`, { headers: TEMP_MAIL_HEADERS }); const m = r.data.map(m=>({id:m.id, from:m.from, subject:m.subject, date:new Date(m.created_at).toLocaleString(), body:m.body_text||m.body_html})); res.json(m); } catch(e){ res.json([]); } });

// IQC Maker
app.post('/api/maker/iqc', async (req, res) => {
    const { text, provider, jam, baterai } = req.body;
    try {
        const targetUrl = `https://api.nexray.web.id/maker/v1/iqc?text=${encodeURIComponent(text)}&provider=${encodeURIComponent(provider)}&jam=${encodeURIComponent(jam)}&baterai=${baterai}`;
        const r = await axiosClient.get(targetUrl, { responseType: 'arraybuffer' });
        const b64 = Buffer.from(r.data).toString('base64');
        res.json({ success: true, image: `data:image/jpeg;base64,${b64}` });
    } catch (e) { res.status(500).json({ success: false, message: "Gagal Make IQC." }); }
});

module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => { console.log(`Server running at http://localhost:${PORT}`); });
}

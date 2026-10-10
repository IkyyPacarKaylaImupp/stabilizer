const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');

// Set ffmpeg path from ffmpeg-static (sudah include libvidstab di build terbaru)
try {
  const ffmpegPath = require('ffmpeg-static');
  const ffprobePath = require('ffprobe-static').path;
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
  if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
  console.log('FFmpeg:', ffmpegPath);
} catch(e){
  console.log('Using system ffmpeg (make sure libvidstab enabled)');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static folders
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

// Ensure folders
['uploads','outputs','tmp'].forEach(d=>{
  if(!fs.existsSync(path.join(__dirname,d))) fs.mkdirSync(path.join(__dirname,d));
});

// ============ MULTER CONFIG ============
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    const taskId = uuidv4();
    req.taskId = taskId;
    cb(null, `${taskId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req,file,cb)=>{
    if(file.mimetype.startsWith('video/')) cb(null,true);
    else cb(new Error('Hanya file video yang diperbolehkan'));
  }
});

// ============ ROUTES ============

app.get('/', (req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'));
});

// 2. ROUTER UPLOAD sesuai request: /upload/app-v1/db
app.post('/upload/app-v1/db', upload.single('video'), async (req,res)=>{
  try {
    if(!req.file) return res.status(400).json({ ok:false, message:'No video uploaded' });
    const taskId = path.parse(req.file.filename).name;
    const inputPath = req.file.path;
    ffmpeg.ffprobe(inputPath, (err, metadata)=>{
      const duration = metadata?.format?.duration || 0;
      res.json({
        ok: true,
        taskId,
        filename: req.file.originalname,
        storedAs: req.file.filename,
        size: req.file.size,
        duration,
        next: `/stabilizer/v-1/tospector?task=${taskId}`,
        download: null
      });
    });
  } catch(err){
    console.error(err);
    res.status(500).json({ ok:false, message: err.message });
  }
});

// 3. ROUTER UTAMA STABILIZER: /stabilizer/v-1/tospector?task=
app.get('/stabilizer/v-1/tospector', (req,res)=>{
  const taskId = req.query.task;
  if(!taskId) return res.status(400).json({ ok:false, message:'Parameter ?task= required' });

  const uploadDir = path.join(__dirname,'uploads');
  const files = fs.readdirSync(uploadDir);
  const inputFile = files.find(f=>f.startsWith(taskId));
  if(!inputFile) return res.status(404).json({ ok:false, message:'Task / video tidak ditemukan' });

  const inputPath = path.join(uploadDir, inputFile);
  const transformsPath = path.join(__dirname,'tmp', `transforms_${taskId}.trf`);
  const outputFilename = `${taskId}_stabilized.mp4`;
  const outputPath = path.join(__dirname,'outputs', outputFilename);

  if(fs.existsSync(outputPath)){
    return res.json({ ok:true, done:true, downloadUrl:`/outputs/${outputFilename}`, taskId });
  }

  const shakiness = parseInt(req.query.shakiness) || 5;
  const accuracy = parseInt(req.query.accuracy) || 15;
  const smoothing = parseInt(req.query.smoothing) || 15;
  const crf = parseInt(req.query.crf) || 18;
  const preset = req.query.preset || 'medium';
  const keepAudio = req.query.keepAudio !== 'false';

  res.writeHead(200,{
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive',
    'Access-Control-Allow-Origin':'*'
  });

  const send = (event, data)=>{
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('log', { msg: 'Memulai Pass 1/2: Analisis getaran...' });

  ffmpeg(inputPath)
    .outputOptions([
      `-vf vidstabdetect=result=${transformsPath}:shakiness=${shakiness}:accuracy=${accuracy}:stepsize=6:mincontrast=0.3:show=0`
    ])
    .format('null')
    .output('-')
    .on('start', cmd=>console.log('PASS1 CMD:', cmd))
    .on('progress', p=>{
      if(p.percent) send('progress', { stage:'detect', percent: Math.round(p.percent/2), raw:p });
    })
    .on('error', (err)=>{
      console.error('PASS1 Error', err);
      send('error', { message: err.message, hint:'Pastikan ffmpeg kamu compiled dengan --enable-libvidstab' });
      if(fs.existsSync(transformsPath)) fs.unlinkSync(transformsPath);
      res.end();
    })
    .on('end', ()=>{
      send('log', { msg: 'Pass 1 selesai. Pass 2/2: Stabilisasi + minimal zoom...' });

      const vf = `vidstabtransform=input=${transformsPath}:smoothing=${smoothing}:optzoom=2:zoomspeed=0.25:zoom=0:interpol=bicubic:crop=keep,unsharp=5:5:0.8:3:3:0.4`;

      const command = ffmpeg(inputPath)
        .videoFilters(vf)
        .outputOptions([
          `-c:v libx264`,
          `-preset ${preset}`,
          `-crf ${crf}`,
          `-pix_fmt yuv420p`,
          `-movflags +faststart`,
          keepAudio ? `-c:a aac` : `-an`,
          keepAudio ? `-b:a 192k` : ``
        ].filter(Boolean))
        .output(outputPath)
        .on('start', cmd=>console.log('PASS2 CMD:', cmd))
        .on('progress', p=>{
          if(p.percent) send('progress', { stage:'transform', percent: 50 + Math.round(p.percent/2), raw:p });
        })
        .on('error', (err)=>{
          console.error('PASS2 Error', err);
          if(err.message.includes('vidstab')){
            send('error', { message:'libvidstab tidak ditemukan di ffmpeg build kamu. Install: apt install libvidstab-dev dan recompile atau pakai ffmpeg-static terbaru' });
          } else {
            send('error', { message: err.message });
          }
          if(fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          if(fs.existsSync(transformsPath)) fs.unlinkSync(transformsPath);
          res.end();
        })
        .on('end', ()=>{
          send('progress', { stage:'done', percent:100 });
          send('done', { 
            ok:true, 
            taskId, 
            downloadUrl:`/outputs/${outputFilename}`,
            message:'Video berhasil distabilkan! Zoom minimal, kualitas high.'
          });
          if(fs.existsSync(transformsPath)) fs.unlinkSync(transformsPath);
          res.end();
        });

      command.run();
    })
    .run();
});

app.get('/download/:taskId', (req,res)=>{
  const taskId = req.params.taskId;
  const file = path.join(__dirname,'outputs', `${taskId}_stabilized.mp4`);
  if(!fs.existsSync(file)) return res.status(404).send('File tidak ditemukan');
  res.download(file, `stabilized_${taskId}.mp4`);
});

app.get('/api/check', (req,res)=>{
  const { exec } = require('child_process');
  exec('ffmpeg -filters | grep vidstab', (err, stdout)=>{
    res.json({
      vidstabSupport: !!stdout,
      ffmpegPath: (()=>{ try{ return require('ffmpeg-static'); } catch{ return 'system'; } })(),
      hint: !stdout ? 'Butuh ffmpeg dengan libvidstab. Di Ubuntu: sudo apt install ffmpeg libvidstab-dev' : 'OK'
    });
  });
});

app.listen(PORT, ()=>{
  console.log(`\n✅ Tospector Stabilizer running di http://localhost:${PORT}`);
  console.log(`Upload endpoint: POST /upload/app-v1/db`);
  console.log(`Stabilizer endpoint: GET /stabilizer/v-1/tospector?task=xxx\n`);
});

// ===== elementos =====
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const btnStart = document.getElementById('btnStart');
const startScr = document.getElementById('start');

const btnFlip  = document.getElementById('btnFlip');
const btnShot  = document.getElementById('btnShot');
const btnAgain = document.getElementById('btnAgain');
const btnSave  = document.getElementById('btnSave');

const btnRec      = document.getElementById('btnRec');
const btnSaveVid  = document.getElementById('btnSaveVid');
const btnAgainVid = document.getElementById('btnAgainVid');

const shootArea       = document.getElementById('shootArea');
const resultArea      = document.getElementById('resultArea');
const resultVideoArea = document.getElementById('resultVideoArea');

const overlayImg = document.getElementById('overlay');

const recBadge = document.getElementById('recBadge');
const recClock = document.getElementById('recClock');

// Aviso in-app
const inapp = document.getElementById('inapp');
const btnOpenExt = document.getElementById('openExternal');
const btnCopy = document.getElementById('copyLink');

// ===== estado =====
let stream, facing = 'environment';
let lastBlob = null;       // foto
let lastVideoBlob = null;  // vídeo

// gravação
let workCanvas, wctx, drawRAF = 0;
let mediaRecorder = null, chunks = [], recStartTs = 0;
let afterStopAction = null; // 'share' | 'discard' | null
let stopTimer = null;

// user agent helpers
const ua = navigator.userAgent || '';
const isAndroid = /Android/i.test(ua);
const isIOS = /iPad|iPhone|iPod/i.test(ua);
const isInApp = /(FBAN|FBAV|Instagram|Line|Twitter|Snapchat|TikTok)/i.test(ua);

// Se abrir dentro de app, mostra aviso e bloqueia capa
if (isInApp) {
  startScr.classList.add('hidden');
  inapp.classList.remove('hidden');
}
btnOpenExt?.addEventListener('click', ()=>{
  const url = location.href;
  if (isAndroid) {
    const intent = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`;
    location.href = intent;
  } else if (isIOS) {
    alert('No iPhone: toque em Compartilhar e escolha "Abrir no Safari".');
  } else {
    window.open(url, '_blank');
  }
});
btnCopy?.addEventListener('click', async ()=>{
  try { await navigator.clipboard.writeText(location.href); btnCopy.textContent = 'Link copiado!'; }
  catch { alert('Copie o link da barra de endereço.'); }
});

// ===== CONFIG DINÂMICA (capas via URL opcional) =====
// ?capa=img.png&moldura=frame.png&dur=30
(function aplicarConfig(){
  const q = new URLSearchParams(location.search);
  const capa  = q.get('capa')    || 'tela-inicial.png';
  const mold  = q.get('moldura') || 'moldura.png';
  startScr.style.backgroundImage = `url("${capa}")`;
  overlayImg.src = mold;
  overlayImg.onload = ()=> overlayImg.classList.remove('hidden');
  overlayImg.onerror = ()=> overlayImg.classList.add('hidden');
})();

// ===== fluxo inicial =====
async function openCameraFromStart() {
  if (startScr.classList.contains('busy')) return;
  startScr.classList.add('busy');
  try {
    await startCamera();
    startScr.classList.add('hidden');

    // garante estado inicial correto dos painéis
    shootArea.classList.remove('hidden');
    resultArea.classList.add('hidden');
    resultVideoArea.classList.add('hidden');
  } catch (e) {
    alert('Não foi possível acessar a câmera. Verifique permissões.');
  } finally {
    startScr.classList.remove('busy');
  }
}
btnStart.addEventListener('click', (ev) => { ev.stopPropagation(); openCameraFromStart(); });
startScr.addEventListener('click', openCameraFromStart);

// ===== câmera =====
async function startCamera(){
  if (stream) stream.getTracks().forEach(t=>t.stop());

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    alert('Abra no navegador (https) para usar a câmera.');
    throw new Error('Insecure or unsupported context');
  }

  const baseVideo = {
    facingMode: { ideal: facing },
    width: { ideal: 1920 },
    height:{ ideal: 1080 },
    aspectRatio: { ideal: 9/16 }
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: baseVideo, audio: true });
  } catch {
    // Se microfone negar, ainda abre sem áudio (permite foto e vídeo sem som)
    stream = await navigator.mediaDevices.getUserMedia({ video: baseVideo, audio: false });
  }

  video.srcObject = stream;
  video.classList.toggle('mirror', facing === 'user');
  await video.play();
}
btnFlip.onclick = async () => {
  facing = (facing === 'user') ? 'environment' : 'user';
  await startCamera();
};

// ===== FOTO =====
btnShot.onclick = async () => {
  if (!video.videoWidth) return;
  const W = canvas.width, H = canvas.height;
  const vw = video.videoWidth, vh = video.videoHeight;
  const { sx, sy, sw, sh } = coverCrop(vw, vh, W, H);

  ctx.clearRect(0,0,W,H);
  if (facing === 'user') {
    ctx.save(); ctx.translate(W,0); ctx.scale(-1,1);
    ctx.drawImage(video, sx,sy,sw,sh, 0,0,W,H); ctx.restore();
  } else {
    ctx.drawImage(video, sx,sy,sw,sh, 0,0,W,H);
  }
  await drawOverlayCover(overlayImg, ctx, W, H);
  lastBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.95));

  shootArea.classList.add('hidden');
  resultArea.classList.remove('hidden');
};

btnAgain.onclick = ()=>{
  lastBlob = null;
  resultArea.classList.add('hidden');
  shootArea.classList.remove('hidden');
};

// Foto: tenta compartilhar (WhatsApp) e cai para download
btnSave.onclick = async ()=>{
  if (!lastBlob) return;
  const filename = `foto-${Date.now()}.jpg`;
  if (navigator.canShare && window.File) {
    try {
      const file = new File([lastBlob], filename, { type:'image/jpeg' });
      if (navigator.canShare({ files:[file] })) {
        await navigator.share({ files:[file], title:'Foto' });
        lastBlob = null;
        resultArea.classList.add('hidden');
        shootArea.classList.remove('hidden');
        return;
      }
    } catch {}
  }
  await saveBlobSmart(lastBlob, filename, 'image/jpeg', true);
  lastBlob = null;
  resultArea.classList.add('hidden');
  shootArea.classList.remove('hidden');
};

// ===== VÍDEO (720×1280 @ 24fps, leve) =====
const qs = new URLSearchParams(location.search);
const maxVideoMs = (Number(qs.get('dur')) || 20) * 1000; // padrão 20s

btnRec.onclick = async ()=>{
  if (!video.videoWidth) return;

  // canvas de composição (vídeo em 720p; foto continua 1080x1920)
  workCanvas = document.createElement('canvas');
  workCanvas.width = 720;
  workCanvas.height = 1280;
  wctx = workCanvas.getContext('2d');

  const fps = 24;
  const canvasStream = workCanvas.captureStream ? workCanvas.captureStream(fps) : null;
  if (!canvasStream){ alert('Seu navegador não suporta gravação com moldura.'); return; }

  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) canvasStream.addTrack(audioTrack);

  // MIME (prioriza MP4)
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=h264,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  let mime = '';
  for (const cand of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(cand)) { mime = cand; break; }
  }

  const recOpts = {};
  if (mime) recOpts.mimeType = mime;
  recOpts.videoBitsPerSecond = 3_000_000; // ~3 Mbps
  recOpts.audioBitsPerSecond = 96_000;    // 96 kbps

  chunks = [];
  mediaRecorder = new MediaRecorder(canvasStream, recOpts);
  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = async ()=> {
    clearTimeout(stopTimer);
    lastVideoBlob = new Blob(chunks, { type: mediaRecorder.mimeType || 'video/webm' });
    stopDrawLoop();
    recBadge.classList.add('hidden');

    if (afterStopAction === 'share') {
      afterStopAction = null;
      await shareVideo(); // tenta WhatsApp; se falhar, baixa
      return;
    }
    if (afterStopAction === 'discard') {
      afterStopAction = null;
      lastVideoBlob = null;
      resultVideoArea.classList.add('hidden');
      shootArea.classList.remove('hidden');
      return;
    }

    resultVideoArea.classList.remove('hidden');
  };

  // UI ao iniciar: já mostra Salvar/Refazer + selo REC
  shootArea.classList.add('hidden');
  resultArea.classList.add('hidden');
  resultVideoArea.classList.remove('hidden');
  recBadge.classList.remove('hidden');

  recStartTs = Date.now();
  updateRecClock();
  mediaRecorder.start(500); // timeslice menor → monta blob mais rápido
  startDrawLoop();

  // auto-stop (limite de duração)
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  }, maxVideoMs);
};

// SALVAR VÍDEO → compartilhar primeiro
btnSaveVid.onclick = async ()=>{
  if (mediaRecorder?.state === 'recording') {
    afterStopAction = 'share';
    mediaRecorder.stop();
    return;
  }
  await shareVideo();
};

// REFAZER (durante ou depois)
btnAgainVid.onclick = ()=>{
  if (mediaRecorder?.state === 'recording') {
    afterStopAction = 'discard';
    mediaRecorder.stop();
    return;
  }
  lastVideoBlob = null;
  resultVideoArea.classList.add('hidden');
  shootArea.classList.remove('hidden');
};

// Compartilha o vídeo (WhatsApp aparece no menu); fallback: download
async function shareVideo(){
  if (!lastVideoBlob) return;

  const mime = mediaRecorder?.mimeType || 'video/webm';
  const ext  = pickVideoExtension(mime);
  const filename = `video-${Date.now()}.${ext}`;

  if (navigator.canShare && window.File) {
    try {
      const file = new File([lastVideoBlob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Vídeo' });
        lastVideoBlob = null;
        resultVideoArea.classList.add('hidden');
        shootArea.classList.remove('hidden');
        return;
      }
    } catch { /* se falhar, baixa */ }
  }

  await saveBlobSmart(lastVideoBlob, filename, mime, /*preferDownload=*/true);
  lastVideoBlob = null;
  resultVideoArea.classList.add('hidden');
  shootArea.classList.remove('hidden');
}

/* ===== desenho contínuo do vídeo (composição com moldura) ===== */
function startDrawLoop(){
  const W = workCanvas.width, H = workCanvas.height;
  const vw = video.videoWidth, vh = video.videoHeight;
  const crop = coverCrop(vw, vh, W, H);

  const draw = ()=>{
    wctx.clearRect(0,0,W,H);
    if (facing === 'user') {
      wctx.save(); wctx.translate(W,0); wctx.scale(-1,1);
      wctx.drawImage(video, crop.sx,crop.sy,crop.sw,crop.sh, 0,0,W,H);
      wctx.restore();
    } else {
      wctx.drawImage(video, crop.sx,crop.sy,crop.sw,crop.sh, 0,0,W,H);
    }
    if (overlayImg && !overlayImg.classList.contains('hidden') && overlayImg.complete) {
      drawImageCover(wctx, overlayImg, W, H);   // cover no vídeo
    }
    drawRAF = requestAnimationFrame(draw);
  };
  drawRAF = requestAnimationFrame(draw);
}
function stopDrawLoop(){ if (drawRAF) cancelAnimationFrame(drawRAF); drawRAF = 0; }

// ===== util =====
function coverCrop(vw, vh, W, H){
  const videoRatio = vw / vh, canvasRatio = W / H;
  let sx, sy, sw, sh;
  if (canvasRatio > videoRatio){
    sw = vw; sh = vw / canvasRatio; sx = 0; sy = (vh - sh) / 2;
  } else {
    sh = vh; sw = vh * canvasRatio; sy = 0; sx = (vw - sw) / 2;
  }
  return { sx, sy, sw, sh };
}

/* Moldura em cover (FOTO) */
function drawOverlayCover(img, ctx, W, H){
  return new Promise((resolve)=>{
    if (!img || img.classList.contains('hidden')) return resolve();
    const draw = ()=>{
      const iw = img.naturalWidth, ih = img.naturalHeight;
      if (!iw || !ih) return resolve();
      const ir = iw/ih, cr = W/H;
      let dw, dh, dx, dy;
      if (cr > ir){ dw = W; dh = W/ir; dx = 0; dy = (H - dh)/2; }
      else{ dh = H; dw = H*ir; dy = 0; dx = (W - dw)/2; }
      ctx.drawImage(img, dx, dy, dw, dh);
      resolve();
    };
    if (img.complete && img.naturalWidth) draw();
    else { img.onload = draw; img.onerror = ()=>resolve(); }
  });
}

/* Moldura em cover (VÍDEO - loop) */
function drawImageCover(ctx, img, W, H){
  const iw = img.naturalWidth, ih = img.naturalHeight; if(!iw||!ih) return;
  const ir = iw/ih, cr = W/H;
  let dw, dh, dx, dy;
  if (cr > ir){ dw = W; dh = W/ir; dx = 0; dy = (H - dh)/2; }
  else{ dh = H; dw = H*ir; dy = 0; dx = (W - dw)/2; }
  ctx.drawImage(img, dx, dy, dw, dh);
}

function pickVideoExtension(mime){
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  return 'webm';
}

// preferir download direto (rápido)
async function saveBlobSmart(blob, filename, mime, preferDownload=true){
  const doDownload = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 0);
  };

  // Android: seletor nativo (se quiser escolher pasta)
  if ('showSaveFilePicker' in window && isAndroid && !preferDownload) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Arquivo', accept: { [mime]: [`.${filename.split('.').pop()}`] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob); await writable.close();
      return;
    } catch {}
  }

  // Download direto (mais rápido)
  doDownload();
}

/* relógio REC */
let clockInt = 0;
function updateRecClock(){
  clearInterval(clockInt);
  const fmt = (n)=> String(n).padStart(2,'0');
  const tick = ()=>{
    const s = Math.floor((Date.now() - recStartTs)/1000);
    const mm = Math.floor(s/60), ss = s%60;
    recClock.textContent = `${fmt(mm)}:${fmt(ss)}`;
  };
  tick();
  clockInt = setInterval(tick, 1000);
}

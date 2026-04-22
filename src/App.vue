<template>
  <div class="app">
    <header>
      <h1>实时语音转文字</h1>
    </header>

    <main>
      <div class="status-ring" :class="status">
        <button class="mic-btn" @click="toggle" :disabled="status === 'connecting'">
          <svg v-if="status !== 'recording'" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      </div>

      <p class="status-label">
        <span v-if="status === 'idle'">点击开始录音</span>
        <span v-else-if="status === 'connecting'">连接中...</span>
        <span v-else-if="status === 'recording'" class="recording-dot">录音中</span>
      </p>

      <p class="engine-label">当前引擎：{{ engineLabel }}</p>
      <button class="engine-toggle" @click="cycleEngine">切换引擎</button>

      <div class="result-box" ref="resultBox">
        <div class="committed-text">{{ committedText }}</div>
        <span class="interim-text">{{ interimText }}</span>
        <span v-if="!committedText && !interimText" class="placeholder">识别结果会显示在这里...</span>
      </div>

      <div class="actions" v-if="committedText || interimText">
        <button ref="copyBtn" class="action-btn" @click="copyText">复制</button>
        <button class="action-btn danger" @click="clearText">清空</button>
      </div>

      <div class="error-bar" v-if="errorMsg">
        {{ errorMsg }}
        <button @click="errorMsg = ''">×</button>
      </div>
    </main>

    <div class="mic-test">
      <p class="mic-test-title">麦克风测试</p>
      <div class="mic-test-controls">
        <button class="action-btn" @click="startMicTest" v-if="!micTesting">开始录音</button>
        <button class="action-btn danger" @click="stopMicTest" v-else>停止并回放</button>
      </div>
      <audio v-if="micTestUrl" :src="micTestUrl" controls style="width:100%;margin-top:8px" />
    </div>

    <div v-if="showConfig" class="config-panel">
      <h3>腾讯云配置</h3>
      <label>APPID<input v-model="config.appId" placeholder="请输入腾讯云 APPID" /></label>
      <label>SecretId<input v-model="config.secretId" placeholder="请输入 SecretId" /></label>
      <label>SecretKey<input v-model="config.secretKey" placeholder="请输入 SecretKey" /></label>
      <p class="config-hint">
        原生识别可以直接使用；腾讯云作为云端备用引擎。这里填的是腾讯云控制台里的凭证。
      </p>
      <div class="config-actions">
        <button class="action-btn" @click="saveConfig">保存配置</button>
        <button class="action-btn danger" @click="showConfig = false">稍后再说</button>
      </div>
    </div>

    <footer>
      <button class="config-toggle" @click="showConfig = !showConfig">
        {{ showConfig ? '收起配置' : '配置云端引擎' }}
      </button>
    </footer>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, reactive, ref } from 'vue'
import { NativeSpeechASR } from './native-asr.js'
import { TencentSpeechASR } from './tencent-asr.js'

const status = ref('idle')
const committedText = ref('')
const interimText = ref('')
const errorMsg = ref('')
const showConfig = ref(false)
const resultBox = ref(null)
const copyBtn = ref(null)
const engineMode = ref('auto')

const engineLabel = computed(() => {
  if (engineMode.value === 'native') return '原生'
  if (engineMode.value === 'tencent') return '腾讯云'
  return '自动'
})

const config = reactive({
  appId: import.meta.env.VITE_TENCENT_APPID || localStorage.getItem('tencent_appid') || '',
  secretId: import.meta.env.VITE_TENCENT_SECRET_ID || localStorage.getItem('tencent_secret_id') || '',
  secretKey: import.meta.env.VITE_TENCENT_SECRET_KEY || localStorage.getItem('tencent_secret_key') || '',
})

let asr = null

function hasNativeSpeechRecognition() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

function hasTencentConfig() {
  return Boolean(config.appId && config.secretId && config.secretKey)
}

function cycleEngine() {
  if (engineMode.value === 'auto') engineMode.value = 'native'
  else if (engineMode.value === 'native') engineMode.value = 'tencent'
  else engineMode.value = 'auto'
}

function createAsr() {
  const handlers = {
    onResult({ committed = '', interim = '', append = false }) {
      if (append) {
        committedText.value += committed
      } else {
        committedText.value = committed
      }
      interimText.value = interim
      scrollToBottom()
    },
    onError(err) {
      errorMsg.value = err.message
      status.value = 'idle'
    },
    onStatusChange(nextStatus) {
      status.value = nextStatus
    },
  }

  if (engineMode.value === 'native') {
    if (!hasNativeSpeechRecognition()) {
      throw new Error('当前浏览器不支持原生语音识别，请切换到腾讯云或使用 Chrome / Edge。')
    }
    return new NativeSpeechASR(handlers)
  }

  if (engineMode.value === 'tencent') {
    if (!hasTencentConfig()) {
      showConfig.value = true
      throw new Error('请先填写并保存腾讯云 APPID、SecretId 和 SecretKey。')
    }
    return new TencentSpeechASR({
      appId: config.appId,
      secretId: config.secretId,
      secretKey: config.secretKey,
      ...handlers,
    })
  }

  if (hasNativeSpeechRecognition()) {
    return new NativeSpeechASR(handlers)
  }

  if (hasTencentConfig()) {
    return new TencentSpeechASR({
      appId: config.appId,
      secretId: config.secretId,
      secretKey: config.secretKey,
      ...handlers,
    })
  }

  showConfig.value = true
  throw new Error('当前浏览器不支持原生语音识别，请先配置腾讯云云端备用引擎。')
}

function toggle() {
  if (status.value === 'recording') {
    asr?.stop()
  } else {
    startRecording()
  }
}

async function startRecording() {
  errorMsg.value = ''
  clearText()

  try {
    asr = createAsr()
    await Promise.resolve(asr.start())
  } catch (err) {
    errorMsg.value = err?.message || '启动录音失败'
    status.value = 'idle'
    asr = null
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (resultBox.value) resultBox.value.scrollTop = resultBox.value.scrollHeight
  })
}

async function copyText() {
  const text = committedText.value + interimText.value
  await navigator.clipboard.writeText(text)
  errorMsg.value = '已复制到剪贴板'
  setTimeout(() => {
    if (errorMsg.value === '已复制到剪贴板') errorMsg.value = ''
  }, 1200)

  if (copyBtn.value) {
    const btn = copyBtn.value
    const oldText = btn.textContent
    btn.textContent = '已复制'
    setTimeout(() => {
      btn.textContent = oldText || '复制'
    }, 1200)
  }
}

function clearText() {
  committedText.value = ''
  interimText.value = ''
}

function saveConfig() {
  localStorage.setItem('tencent_appid', config.appId)
  localStorage.setItem('tencent_secret_id', config.secretId)
  localStorage.setItem('tencent_secret_key', config.secretKey)
  showConfig.value = false
  errorMsg.value = ''
}

const micTesting = ref(false)
const micTestUrl = ref('')
let mediaRecorder = null
let micChunks = []

function startMicTest() {
  micTestUrl.value = ''
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    micChunks = []
    mediaRecorder = new MediaRecorder(stream)
    mediaRecorder.ondataavailable = e => micChunks.push(e.data)
    mediaRecorder.onstop = () => {
      const blob = new Blob(micChunks, { type: 'audio/webm' })
      micTestUrl.value = URL.createObjectURL(blob)
      stream.getTracks().forEach(t => t.stop())
    }
    mediaRecorder.start()
    micTesting.value = true
  }).catch(err => {
    errorMsg.value = '麦克风访问失败：' + err.message
  })
}

function stopMicTest() {
  mediaRecorder?.stop()
  micTesting.value = false
}

onUnmounted(() => asr?.stop())
</script>

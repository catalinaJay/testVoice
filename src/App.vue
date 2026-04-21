<template>
  <div class="app">
    <header>
      <h1>实时语音转文字</h1>
    </header>

    <main>
      <!-- 状态指示 -->
      <div class="status-ring" :class="status">
        <button class="mic-btn" @click="toggle" :disabled="status === 'connecting'">
          <svg v-if="status !== 'recording'" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        </button>
      </div>

      <p class="status-label">
        <span v-if="status === 'idle'">点击开始录音</span>
        <span v-else-if="status === 'connecting'">连接中...</span>
        <span v-else-if="status === 'recording'" class="recording-dot">录音中</span>
      </p>

      <!-- 实时文字区 -->
      <div class="result-box" ref="resultBox">
        <div class="committed-text">{{ committedText }}</div>
        <span class="interim-text">{{ interimText }}</span>
        <span v-if="!committedText && !interimText" class="placeholder">识别结果将显示在这里...</span>
      </div>

      <!-- 操作按钮 -->
      <div class="actions" v-if="committedText">
        <button class="action-btn" @click="copyText">复制</button>
        <button class="action-btn danger" @click="clearText">清空</button>
      </div>

      <!-- 错误提示 -->
      <div class="error-bar" v-if="errorMsg">
        {{ errorMsg }}
        <button @click="errorMsg = ''">×</button>
      </div>
    </main>

    <!-- 麦克风测试 -->
    <div class="mic-test">
      <p class="mic-test-title">麦克风测试</p>
      <div class="mic-test-controls">
        <button class="action-btn" @click="startMicTest" v-if="!micTesting">开始录音</button>
        <button class="action-btn danger" @click="stopMicTest" v-else>停止并回放</button>
      </div>
      <audio v-if="micTestUrl" :src="micTestUrl" controls style="width:100%;margin-top:8px" />
    </div>
    <!-- <div class="config-panel" v-if="showConfig"> -->
      <h3>讯飞 API 配置</h3>
      <label>APPID<input v-model="config.appId" placeholder="请输入 APPID" /></label>
      <label>APIKey<input v-model="config.apiKey" placeholder="请输入 APIKey" /></label>
      <label>APISecret<input v-model="config.apiSecret" placeholder="请输入 APISecret" /></label>
    <!-- </div> -->

    <footer>
      <button class="config-toggle" @click="showConfig = !showConfig">
        {{ showConfig ? '收起配置' : '⚙ 配置 API' }}
      </button>
    </footer>
  </div>
</template>

<script setup>
import { ref, reactive, nextTick, onUnmounted } from 'vue'
import { NativeSpeechASR } from './native-asr.js'

const status = ref('idle')
const committedText = ref('')
const interimText = ref('')
const errorMsg = ref('')
const showConfig = ref(false)
const resultBox = ref(null)

const config = reactive({
  appId: import.meta.env.VITE_XUNFEI_APPID || localStorage.getItem('xf_appid') || '',
  apiKey: import.meta.env.VITE_XUNFEI_API_KEY || localStorage.getItem('xf_apikey') || '',
  apiSecret: import.meta.env.VITE_XUNFEI_API_SECRET || localStorage.getItem('xf_apisecret') || '',
})

// 如果没有配置则展开配置面板
if (!config.appId || !config.apiKey || !config.apiSecret) showConfig.value = true

let asr = null

function toggle() {
  if (status.value === 'recording') {
    asr?.stop()
  } else {
    startRecording()
  }
}

function startRecording() {
  asr = new NativeSpeechASR({
    onResult({ committed, interim }) {
      committedText.value = committed
      interimText.value = interim
      scrollToBottom()
    },
    onError(err) {
      errorMsg.value = err.message
      status.value = 'idle'
    },
    onStatusChange(s) {
      status.value = s
    },
  })

  asr.start()
}

function scrollToBottom() {
  nextTick(() => {
    if (resultBox.value) resultBox.value.scrollTop = resultBox.value.scrollHeight
  })
}

function copyText() {
  const text = committedText.value + interimText.value
  navigator.clipboard.writeText(text).then(() => {
    const orig = errorMsg.value
    errorMsg.value = ''
    // 用一个短暂的成功提示
    const btn = document.querySelector('.action-btn')
    if (btn) { btn.textContent = '已复制!'; setTimeout(() => btn.textContent = '复制', 1500) }
  })
}

function clearText() {
  committedText.value = ''
  interimText.value = ''
}

function saveConfig() {
  localStorage.setItem('xf_appid', config.appId)
  localStorage.setItem('xf_apikey', config.apiKey)
  localStorage.setItem('xf_apisecret', config.apiSecret)
  showConfig.value = false
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
  }).catch(err => errorMsg.value = '麦克风访问失败: ' + err.message)
}

function stopMicTest() {
  mediaRecorder?.stop()
  micTesting.value = false
}

onUnmounted(() => asr?.stop())
</script>

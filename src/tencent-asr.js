/**
 * 腾讯云实时语音识别（WebSocket）
 * 官方接口: wss://asr.cloud.tencent.com/asr/v2/<appid>
 */

const HOST = 'asr.cloud.tencent.com'
const PATH_PREFIX = '/asr/v2'
const SAMPLE_RATE = 16000
const FRAME_BYTES = 6400 // 200ms @ 16kHz mono 16-bit PCM

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

async function hmacSha1Base64(secret, message) {
  const keyBytes = new TextEncoder().encode(secret)
  const msgBytes = new TextEncoder().encode(message)
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, msgBytes)
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

function toSeconds() {
  return Math.floor(Date.now() / 1000)
}

async function buildSignedUrl({ appId, secretId, secretKey, voiceId }) {
  const timestamp = toSeconds()
  const expired = timestamp + 60 * 60
  const nonce = Math.floor(Math.random() * 1e9)
  const params = {
    engine_model_type: '16k_zh',
    expired,
    needvad: 1,
    nonce,
    secretid: secretId,
    timestamp,
    voice_format: 1,
    voice_id: voiceId,
  }

  const query = Object.keys(params)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&')

  const signOrigin = `${HOST}${PATH_PREFIX}/${appId}?${query}`
  const signature = await hmacSha1Base64(secretKey, signOrigin)
  return `wss://${HOST}${PATH_PREFIX}/${appId}?${query}&signature=${encodeURIComponent(signature)}`
}

function extractText(resultList) {
  if (!resultList) return ''
  if (Array.isArray(resultList)) {
    return resultList.map(item => item.voice_text_str || '').join('')
  }
  return resultList.voice_text_str || ''
}

export class TencentSpeechASR {
  constructor({ appId, secretId, secretKey, onResult, onError, onStatusChange }) {
    this.appId = appId
    this.secretId = secretId
    this.secretKey = secretKey
    this.onResult = onResult
    this.onError = onError
    this.onStatusChange = onStatusChange

    this.ws = null
    this.audioContext = null
    this.processor = null
    this.stream = null
    this.isRecording = false
    this.pendingAudio = new Uint8Array(0)
    this.voiceId = ''
    this.handshakeReady = false
    this.sentEnded = false
  }

  async start() {
    try {
      this.onStatusChange?.('connecting')
      this.pendingAudio = new Uint8Array(0)
      this.voiceId = uuid()
      this.handshakeReady = false
      this.sentEnded = false

      const url = await buildSignedUrl({
        appId: this.appId,
        secretId: this.secretId,
        secretKey: this.secretKey,
        voiceId: this.voiceId,
      })

      await this._connect(url)
      await this._startMicrophone()
      this.isRecording = true
      this.onStatusChange?.('recording')
    } catch (err) {
      this.onError?.(err)
      this.onStatusChange?.('idle')
      this.stop()
    }
  }

  stop() {
    this.isRecording = false
    this._stopMicrophone()

    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.sentEnded) {
      this._flushPendingAudio()
      this.ws.send(JSON.stringify({ type: 'end' }))
      this.sentEnded = true
      setTimeout(() => this.ws?.close(), 300)
    }

    this.pendingAudio = new Uint8Array(0)
    this.onStatusChange?.('idle')
  }

  _connect(url) {
    return new Promise((resolve, reject) => {
      let settled = false

      const rejectOnce = (message) => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }

      this.ws = new WebSocket(url)
      this.ws.binaryType = 'arraybuffer'

      this.ws.onopen = () => {
        console.log('[Tencent ASR] websocket open')
      }

      this.ws.onerror = (e) => {
        console.error('[Tencent ASR] websocket error', e)
      }

      this.ws.onmessage = (e) => {
        const msg = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data))
        console.log('[Tencent ASR] message', msg)

        if (!this.handshakeReady) {
          if (msg.code === 0) {
            this.handshakeReady = true
            settled = true
            resolve()
            return
          }

          rejectOnce(`腾讯云握手失败（${msg.code}）：${msg.message || 'unknown'}`)
          this.ws?.close()
          return
        }

        if (msg.code && msg.code !== 0) {
          this.onError?.(new Error(`腾讯云识别错误（${msg.code}）：${msg.message || 'unknown'}`))
          this.ws?.close()
          return
        }

        const result = msg.result || msg.result_list
        if (result) {
          const text = extractText(result)
          const sliceType = Array.isArray(result) ? result.some(item => item.slice_type === 2) : result.slice_type === 2
          const isFinal = msg.final === 1 || sliceType

          this.onResult?.({
            committed: isFinal ? text : '',
            interim: isFinal ? '' : text,
            append: isFinal,
          })
        }

        if (msg.final === 1) {
          this.ws?.close()
        }
      }

      this.ws.onclose = (e) => {
        console.log('[Tencent ASR] websocket closed', e.code, e.reason)
        if (!settled && !this.handshakeReady) {
          const reason = e.reason ? `：${e.reason}` : ''
          rejectOnce(`腾讯云 WebSocket 连接失败（${e.code}）${reason}。请检查 AppID / SecretId / SecretKey、服务开通状态、系统时间和网络。`)
        }

        if (this.isRecording) {
          this.isRecording = false
          this.onStatusChange?.('idle')
        }
      }
    })
  }

  async _startMicrophone() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true },
      video: false,
    })

    this.audioContext = new AudioContext()
    const nativeRate = this.audioContext.sampleRate

    const source = this.audioContext.createMediaStreamSource(this.stream)
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1)

    this.processor.onaudioprocess = e => {
      if (!this.isRecording || !this.handshakeReady || this.ws?.readyState !== WebSocket.OPEN) return

      const float32 = e.inputBuffer.getChannelData(0)
      const resampled = this._downsample(float32, nativeRate, SAMPLE_RATE)
      const pcm = this._float32ToPcm16(resampled)
      this._queueAudio(pcm)
    }

    source.connect(this.processor)
    this.processor.connect(this.audioContext.destination)
  }

  _stopMicrophone() {
    this.processor?.disconnect()
    this.audioContext?.close()
    this.stream?.getTracks().forEach(t => t.stop())
    this.processor = null
    this.audioContext = null
    this.stream = null
  }

  _downsample(buffer, fromRate, toRate) {
    if (fromRate === toRate) return buffer
    const ratio = fromRate / toRate
    const newLength = Math.round(buffer.length / ratio)
    const result = new Float32Array(newLength)
    for (let i = 0; i < newLength; i++) {
      const start = Math.floor(i * ratio)
      const end = Math.min(Math.floor((i + 1) * ratio), buffer.length)
      let sum = 0
      for (let j = start; j < end; j++) sum += buffer[j]
      result[i] = end > start ? sum / (end - start) : 0
    }
    return result
  }

  _float32ToPcm16(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2)
    const view = new DataView(buffer)
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]))
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return buffer
  }

  _queueAudio(pcmBuffer) {
    const incoming = new Uint8Array(pcmBuffer)
    const merged = new Uint8Array(this.pendingAudio.length + incoming.length)
    merged.set(this.pendingAudio, 0)
    merged.set(incoming, this.pendingAudio.length)

    let offset = 0
    while (merged.length - offset >= FRAME_BYTES) {
      const chunk = merged.slice(offset, offset + FRAME_BYTES)
      this._sendAudioChunk(chunk)
      offset += FRAME_BYTES
    }

    this.pendingAudio = merged.slice(offset)
  }

  _flushPendingAudio() {
    if (!this.pendingAudio.length || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this._sendAudioChunk(this.pendingAudio)
    this.pendingAudio = new Uint8Array(0)
  }

  _sendAudioChunk(audioBytes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength))
  }
}

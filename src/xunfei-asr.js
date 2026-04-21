/**
 * 讯飞 IAT 实时语音听写 WebSocket 封装
 * 接口: wss://iat-api.xfyun.cn/v2/iat
 * 鉴权: HMAC-SHA256 (host + date + request-line)
 * 音频: PCM 16kHz 16bit 单声道，base64 编码后放 JSON
 */

const HOST = 'iat-api.xfyun.cn'
const PATH = '/v2/iat'
const WS_URL = `wss://${HOST}${PATH}`

async function getAuthUrl(apiKey, apiSecret) {
  const date = new Date().toUTCString()
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`

  const keyBytes = new TextEncoder().encode(apiSecret)
  const msgBytes = new TextEncoder().encode(signatureOrigin)
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgBytes)
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))

  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  const authorization = btoa(authorizationOrigin)

  const url = `${WS_URL}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${HOST}`
  console.log('[ASR] 连接 URL:', url)
  return url
}

export class XunfeiASR {
  constructor({ appId, apiKey, apiSecret, onResult, onError, onStatusChange }) {
    this.appId = appId
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.onResult = onResult
    this.onError = onError
    this.onStatusChange = onStatusChange

    this.ws = null
    this.audioContext = null
    this.processor = null
    this.stream = null
    this.isRecording = false

    this.resultText = ''
    this.resultTextTemp = ''
  }

  async start() {
    try {
      this.onStatusChange?.('connecting')
      this.resultText = ''
      this.resultTextTemp = ''
      const url = await getAuthUrl(this.apiKey, this.apiSecret)
      await this._openWebSocket(url)
      await this._startMicrophone()
      this.isRecording = true
      this.onStatusChange?.('recording')
    } catch (err) {
      this.onError?.(err)
      this.onStatusChange?.('idle')
    }
  }

  stop() {
    this.isRecording = false
    this._stopMicrophone()
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' } }))
      setTimeout(() => this.ws?.close(), 300)
    }
    this.onStatusChange?.('idle')
  }

  _openWebSocket(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url)
      this.ws.onopen = () => {
        // 连接成功后立即发送首帧（含业务参数，无音频数据）
        this.ws.send(JSON.stringify({
          common: { app_id: this.appId },
          business: {
            language: 'zh_cn',
            domain: 'iat',
            accent: 'mandarin',
            vad_eos: 5000,
            dwa: 'wpgs',
            ptt: 1,
          },
          data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw' },
        }))
        resolve()
      }
      this.ws.onerror = (e) => {
        console.error('[ASR] WebSocket error', e)
        reject(new Error('WebSocket 连接失败，请检查网络或凭证'))
      }
      this.ws.onmessage = e => this._handleMessage(e.data)
      this.ws.onclose = (e) => {
        console.log('[ASR] WebSocket closed', e.code, e.reason)
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
    console.log('[ASR] AudioContext 实际采样率:', nativeRate)

    const source = this.audioContext.createMediaStreamSource(this.stream)
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1)

    this.processor.onaudioprocess = e => {
      if (!this.isRecording || this.ws?.readyState !== WebSocket.OPEN) return
      const float32 = e.inputBuffer.getChannelData(0)
      const maxAmp = float32.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
      if (maxAmp > 0.001) console.log('[ASR] 音频振幅:', maxAmp.toFixed(4))

      const resampled = this._downsample(float32, nativeRate, 16000)
      const pcm = this._float32ToPcm16(resampled)
      const audio = btoa(String.fromCharCode(...new Uint8Array(pcm)))
      this.ws.send(JSON.stringify({ data: { status: 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio } }))
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
      result[i] = sum / (end - start)
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

  _handleMessage(data) {
    try {
      const msg = JSON.parse(data)
      console.log('[ASR] 收到消息:', msg)

      if (msg.code !== 0) {
        this.onError?.(new Error(`讯飞错误 ${msg.code}: ${msg.message}`))
        this.ws?.close()
        return
      }

      if (msg.data?.result) {
        const result = msg.data.result
        const text = result.ws?.flatMap(w => w.cw)?.map(c => c.w)?.join('') ?? ''

        if (result.pgs) {
          if (result.pgs === 'apd') {
            this.resultText = this.resultTextTemp
          }
          this.resultTextTemp = this.resultText + text
          this.onResult?.({ committed: this.resultText, interim: text })
        } else {
          this.resultText = this.resultText + text
          this.resultTextTemp = this.resultText
          this.onResult?.({ committed: this.resultText, interim: '' })
        }
        console.log('[ASR] 提取文字:', JSON.stringify(text), '| ws原始:', JSON.stringify(result.ws))
      }

      if (msg.data?.status === 2) {
        this.ws?.close()
      }
    } catch (e) {
      console.error('[ASR] 消息解析失败', e)
    }
  }
}

/**
 * 浏览器原生 Web Speech API 封装
 * 无需任何 API Key，Chrome / Edge 通常可用
 */

export class NativeSpeechASR {
  constructor({ onResult, onError, onStatusChange }) {
    this.onResult = onResult
    this.onError = onError
    this.onStatusChange = onStatusChange

    this.recognition = null
    this.isRecording = false
    this.committedText = ''
  }

  start() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      this.onError?.(new Error('当前浏览器不支持语音识别，请使用 Chrome / Edge，或切换到云端备用引擎。'))
      return
    }

    this.committedText = ''
    this.recognition = new SpeechRecognition()
    this.recognition.lang = 'zh-CN'
    this.recognition.continuous = true
    this.recognition.interimResults = true

    this.recognition.onstart = () => {
      this.isRecording = true
      this.onStatusChange?.('recording')
    }

    this.recognition.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          this.committedText += transcript
        } else {
          interim += transcript
        }
      }
      this.onResult?.({ committed: this.committedText, interim })
    }

    this.recognition.onerror = (event) => {
      if (event.error === 'no-speech') return
      this.onError?.(new Error(`语音识别错误: ${event.error}`))
    }

    this.recognition.onend = () => {
      if (this.isRecording) this.recognition.start()
    }

    this.onStatusChange?.('connecting')
    try {
      this.recognition.start()
    } catch (err) {
      this.onError?.(new Error(`启动语音识别失败: ${err.message}`))
      this.onStatusChange?.('idle')
      this.recognition = null
    }
  }

  stop() {
    this.isRecording = false
    this.recognition?.stop()
    this.recognition = null
    this.onStatusChange?.('idle')
  }
}

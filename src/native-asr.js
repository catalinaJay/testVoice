/**
 * 浏览器原生 Web Speech API 封装
 * 无需任何 API Key，Chrome 内置，支持中文
 * 兼容性：Chrome / Edge（Firefox 不支持）
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
      this.onError?.(new Error('当前浏览器不支持语音识别，请使用 Chrome 或 Edge'))
      return
    }

    this.committedText = ''
    this.recognition = new SpeechRecognition()
    this.recognition.lang = 'zh-CN'
    this.recognition.continuous = true       // 持续识别，不自动停止
    this.recognition.interimResults = true   // 返回实时中间结果

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
      if (event.error === 'no-speech') return  // 静默不报错
      this.onError?.(new Error(`语音识别错误: ${event.error}`))
    }

    this.recognition.onend = () => {
      // continuous 模式下意外停止时自动重启
      if (this.isRecording) this.recognition.start()
    }

    this.onStatusChange?.('connecting')
    this.recognition.start()
  }

  stop() {
    this.isRecording = false
    this.recognition?.stop()
    this.recognition = null
    this.onStatusChange?.('idle')
  }
}

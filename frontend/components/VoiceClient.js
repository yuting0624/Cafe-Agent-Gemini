import { useState, useRef, useEffect } from "react";
import { VoicecallBackendAPI } from "lib/voicecall-backend";
import {
  LiveAudioInputManager,
  LiveAudioOutputManager
} from "lib/live-audio-manager";

/**
 * 【ハンズオン教材】Starlight Cafe 音声対話システム
 * 
 * このコンポーネントは以下の機能を提供します：
 * 1. Gemini Live APIとのWebSocket接続
 * 2. リアルタイム音声入出力管理
 * 3. カフェらしいユーザーインターface
 * 
 * 【カスタマイズポイント】
 * - menuData: メニュー内容を自由に変更可能
 * - questionHints: 質問例を追加・変更可能
 * - UI要素: 色やレイアウトを調整可能
 */
export default function VoiceClient() {

  // ===== 基本設定とユーティリティ =====
  const sleep = (time) => new Promise((r) => setTimeout(r, time));
  const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;
  
  // ===== 状態管理 =====
  const [connectionStatus, setConnectionStatus] = useState("disconnected"); // "disconnected" | "connected"
  const [micStatus, setMicStatus] = useState("off"); // "on" | "off"
  const [buttonDisabled, setButtonDisabled] = useState(false);
  const [transcriptions, setTranscriptions] = useState([]); // トランスクリプション履歴

  // ===== ユニークID生成用 =====
  const transcriptionIdRef = useRef(0);
  const generateUniqueId = () => {
    transcriptionIdRef.current += 1;
    return `transcription_${Date.now()}_${transcriptionIdRef.current}`;
  };

  // ===== API・音声管理のセットアップ =====
  const _voicecallApi = useRef(new VoicecallBackendAPI(BACKEND_URL));
  const voicecallApi = _voicecallApi.current;

  const _liveAudioOutputManager = useRef();
  const _liveAudioInputManager = useRef();
  const liveAudioOutputManager = _liveAudioOutputManager.current;
  const liveAudioInputManager = _liveAudioInputManager.current;

  // 音声管理ライブラリの初期化
  useEffect(() => {
    _liveAudioInputManager.current = new LiveAudioInputManager();
    _liveAudioOutputManager.current = new LiveAudioOutputManager();
  }, []); 

  // ===== 音声入出力の制御 =====
  
  // 接続状態変化時の音声入力制御
  useEffect(() => {
    if (connectionStatus == "connected") {
      startAudioInput(); // マイクへのアクセス開始
      setMicStatus("off"); // 初期状態はマイクオフ
      setTranscriptions([]); // トランスクリプション履歴をクリア
      transcriptionIdRef.current = 0; // IDカウンターをリセット
    } else {
      stopAudioStream(); // 音声ストリーミング停止
      stopAudioInput(); // マイクアクセス停止
    }
  }, [connectionStatus]);

  // マイク状態変化時の音声ストリーミング制御
  useEffect(() => {
    if (micStatus == "on") {
      startAudioStream(); // 音声データ送信開始
    } else {
      const _stopAudioStream = async () => {
        await sleep(2000); // 音声データ送信完了まで待機
        stopAudioStream();
      };
      _stopAudioStream();
    }
  }, [micStatus]);

  // マイクアクセス開始
  const startAudioInput = async () => {
    if (!liveAudioInputManager) return;
    await liveAudioInputManager.connectMicrophone();
  };

  // マイクアクセス停止
  const stopAudioInput = async () => {
    if (!liveAudioInputManager) return;
    await liveAudioInputManager.disconnectMicrophone();
  };

  // 音声データストリーミング開始
  const startAudioStream = () => {
    if (!voicecallApi.isConnected) return;
    liveAudioInputManager.onNewAudioRecordingChunk = (audioData) => {
      console.log("音声データを送信中...");
      voicecallApi.sendAudioMessage(audioData);
    };
  }

  // 音声データストリーミング停止
  const stopAudioStream = () => {
    if (!liveAudioInputManager) return;
    liveAudioInputManager.onNewAudioRecordingChunk = () => {};
  }

  // ===== WebSocket接続制御 =====
  
  // バックエンドへの接続開始
  const connectToBackend = async () => {
    setButtonDisabled(true);
    voicecallApi.connect();
    
    // 接続完了まで待機
    while (!voicecallApi.isConnected()) {
      await sleep(500);
      if (voicecallApi.isClosed()) {
        disconnectFromBackend();
        return;
      }
    }
    
    setButtonDisabled(false);
    setConnectionStatus("connected");
  };

  // バックエンドからの切断
  const disconnectFromBackend = async () => {
    setButtonDisabled(true);
    await voicecallApi.disconnect();
    await sleep(500);
    setButtonDisabled(false);
    setConnectionStatus("disconnected");
  };

  // ===== 音声応答の受信処理 =====
  voicecallApi.onReceiveResponse = (messageResponse) => {
    if (messageResponse.type == "audio") {
      console.log("音声応答を受信しました");
      const audioChunk = messageResponse.data;
      liveAudioOutputManager.playAudioChunk(audioChunk);
    } else if (messageResponse.type == "input_transcription") {
      // ユーザーの音声入力の文字起こし
      console.log("音声入力テキスト:", messageResponse.text);
      const text = messageResponse.text.trim();
      
      // 短すぎるテキストは無視
      if (text.length <= 2) {
        return;
      }
      
      setTranscriptions(prev => [...prev, {
        id: generateUniqueId(),
        text: text,
        timestamp: new Date(),
        type: 'input'
      }]);
    } else if (messageResponse.type == "output_transcription") {
      // AI音声応答の文字起こし（完全な文章のみ）
      const text = messageResponse.text.trim();
      console.log("音声出力テキスト:", text);
      
      // 短すぎるテキスト（3文字以下）は無視
      if (text.length <= 3) {
        return;
      }
      
      // 文章が完結しているかチェック（句点、疑問符、感嘆符で終わる）
      const isComplete = text.endsWith('。') || text.endsWith('？') || text.endsWith('！') || 
                        text.endsWith('.') || text.endsWith('?') || text.endsWith('!');
      
      if (isComplete && text.length > 10) {
        // 完全な文章の場合のみ追加
        setTranscriptions(prev => [...prev, {
          id: generateUniqueId(),
          text: text,
          timestamp: new Date(),
          type: 'output'
        }]);
      }
    }
  };

  // ===== 【ハンズオン・カスタマイズ可能】メニューデータ（厳選版） =====
  // 🎯 練習: このメニューデータを変更して、オリジナルカフェを作ってみましょう！
  const cafeMenuData = {
    coffee: [
      { name: "ドリップコーヒー", price: "450円", description: "ホット/アイス対応" },
      { name: "カフェラテ", price: "550円", description: "人気No.1！まろやかな味わい" },
      { name: "カプチーノ", price: "550円", description: "ふわふわフォームが自慢" },
      { name: "エスプレッソ", price: "350円", description: "本格イタリアン" }
    ],
    food: [
      { name: "ホットサンドイッチ", price: "780円", description: "具だくさんでボリューム満点" },
      { name: "日替わりパスタ", price: "1,000円", description: "サラダ付きセット" },
      { name: "チーズケーキ", price: "480円", description: "濃厚でクリーミー" },
      { name: "アップルパイ", price: "520円", description: "温めてご提供" }
    ]
  };

  // ===== 【ハンズオン・カスタマイズ可能】質問ヒント =====
  // 🎯 練習: 新しい質問例を追加してみましょう！
  const conversationHints = [
    "📋 「メニューを教えてください」",
    "☕ 「おすすめのコーヒーは？」",
    "⏰ 「営業時間は何時まで？」",
    "📍 「場所はどこですか？」",
    "🚗 「テイクアウトできますか？」",
    "💳 「支払い方法は？」"
  ];

  // ===== UIコンポーネント生成 =====
  
  // 接続ボタンの状態別表示
  const renderConnectionButton = () => {
    if (buttonDisabled) {
      return (
        <button className="w-full bg-gray-400 text-white font-bold py-4 px-8 rounded-xl shadow-lg transition-all duration-200 text-lg">
          {(connectionStatus == "connected") ? "接続を切断中..." : "接続中..."}
        </button>
      );
    } else if (connectionStatus == "connected") {
      return (
        <button 
          className="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-4 px-8 rounded-xl shadow-lg transition-all duration-200 transform hover:scale-105 text-lg"
          onClick={disconnectFromBackend}
        >
          🔌 通話を終了
        </button>
      );
    } else {
      return (
        <button 
          className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-4 px-8 rounded-xl shadow-lg transition-all duration-200 transform hover:scale-105 text-lg animate-pulse"
          onClick={connectToBackend}
        >
          ☕ カフェに電話をかける
        </button>
      );
    }
  };

  // マイクボタンの状態別表示
  const renderMicrophoneButton = () => {
    if (connectionStatus !== "connected") return null;

    if (micStatus == "on") {
      return (
        <button 
          className="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-4 px-8 rounded-xl shadow-lg transition-all duration-200 flex items-center justify-center space-x-3 text-lg"
          onClick={() => setMicStatus("off")}
        >
          <span className="text-2xl animate-pulse">🎤</span>
          <span>話すのをやめる</span>
        </button>
      );
    } else {
      return (
        <button 
          className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-4 px-8 rounded-xl shadow-lg transition-all duration-200 flex items-center justify-center space-x-3 text-lg"
          onClick={() => setMicStatus("on")}
        >
          <span className="text-2xl">🎤</span>
          <span>話し始める</span>
        </button>
      );
    }
  };

  // 接続状態インジケーター
  const renderStatusIndicator = () => (
    <div className="flex items-center justify-center space-x-3 mb-6 p-4 bg-white rounded-xl shadow-md">
      <div className={`w-4 h-4 rounded-full ${connectionStatus === "connected" ? "bg-green-500 animate-pulse" : "bg-gray-400"}`}></div>
      <span className="text-lg font-medium text-gray-700">
        {connectionStatus === "connected" ? "📞 Patrickと通話中" : "📞 未接続"}
      </span>
    </div>
  );

  // メニュー項目の表示コンポーネント
  const renderMenuItem = (item, index) => (
    <div key={index} className="border-b border-amber-100 pb-3 last:border-b-0">
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <h3 className="font-semibold text-gray-800 text-base">{item.name}</h3>
          <p className="text-sm text-gray-600 mt-1">{item.description}</p>
        </div>
        <span className="text-lg font-bold text-amber-700 ml-4">{item.price}</span>
      </div>
    </div>
  );

  // トランスクリプション表示コンポーネント
  const renderTranscriptions = () => {
    if (transcriptions.length === 0) {
      return (
        <div className="text-center text-gray-500 text-sm py-8">
          <div className="text-4xl mb-2">🎙️</div>
          <p>音声認識が開始されると</p>
          <p>会話内容がここに表示されます</p>
        </div>
      );
    }

    return (
      <div className="space-y-3 max-h-80 overflow-y-auto">
        {transcriptions.map((transcription, index) => (
          <div key={transcription.id} className={`p-4 rounded-lg border-l-4 ${
            transcription.type === 'input' 
              ? 'bg-slate-50 border-l-slate-300' 
              : 'bg-amber-50 border-l-amber-300'
          }`}>
            <div className="flex justify-between items-start mb-2">
              <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                transcription.type === 'input' 
                  ? 'bg-slate-200 text-slate-700' 
                  : 'bg-amber-200 text-amber-700'
              }`}>
                {transcription.type === 'input' ? '🎤 音声入力' : '🗣️ 音声出力'}
              </span>
              <span className="text-xs text-gray-500">
                {transcription.timestamp.toLocaleTimeString()}
              </span>
            </div>
            <p className="text-sm text-gray-800 leading-relaxed">{transcription.text}</p>
          </div>
        ))}
      </div>
    );
  };

  // ===== メインレンダリング =====
  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-100 p-6">
      {/* ヘッダーセクション */}
      <div className="text-center mb-8">
        <div className="text-6xl mb-4">☕</div>
        <h1 className="text-5xl font-bold text-amber-800 mb-3">
          Starlight Cafe
        </h1>
        <p className="text-xl text-gray-600 mb-2">
          AIスタッフPatrickとの音声通話システム
        </p>
        <p className="text-lg text-amber-700 font-semibold">
          🏢 東京都渋谷区 | ⏰ 7:00-22:00（年中無休）
        </p>
      </div>

      {/* メインコンテンツ - バランス調整された3カラムレイアウト */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* 左側: 通話コントロール + 質問ヒント */}
        <div className="space-y-6">
          {/* 通話ステータス */}
          {renderStatusIndicator()}
          
          {/* 通話コントロールパネル */}
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <h2 className="text-2xl font-bold text-amber-800 mb-6 text-center">通話コントロール</h2>
            <div className="space-y-4">
              {renderConnectionButton()}
              {connectionStatus === "connected" && renderMicrophoneButton()}
            </div>
            
            {connectionStatus === "connected" && (
              <div className="mt-6 p-4 bg-amber-50 rounded-lg border border-amber-200">
                <h3 className="text-sm font-semibold text-amber-800 mb-2">💡 操作方法</h3>
                <ul className="text-xs text-gray-700 space-y-1">
                  <li>• 「話し始める」ボタンを押して話しかけてください</li>
                  <li>• Patrickが応答するまで少しお待ちください</li>
                  <li>• 話し終わったら「話すのをやめる」を押してください</li>
                </ul>
              </div>
            )}
          </div>

          {/* 質問ヒント */}
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <h2 className="text-2xl font-bold text-amber-800 mb-4 flex items-center">
              💬 試してみよう！
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              Patrickに以下のような質問をしてみてください：
            </p>
            <div className="grid grid-cols-1 gap-2">
              {conversationHints.map((hint, index) => (
                <div key={index} className="bg-amber-50 p-3 rounded-lg border border-amber-200 hover:bg-amber-100 transition-colors cursor-pointer">
                  <p className="text-sm text-gray-700">{hint}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 中央: メニュー */}
        <div className="space-y-6">
          {/* コーヒーメニュー */}
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <h2 className="text-2xl font-bold text-amber-800 mb-6 flex items-center">
              ☕ コーヒーメニュー
            </h2>
            <div className="space-y-4">
              {cafeMenuData.coffee.map(renderMenuItem)}
            </div>
          </div>

          {/* フードメニュー */}
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <h2 className="text-2xl font-bold text-amber-800 mb-6 flex items-center">
              🥪 フードメニュー
            </h2>
            <div className="space-y-4">
              {cafeMenuData.food.map(renderMenuItem)}
            </div>
          </div>
        </div>

        {/* 右側: 会話ログ + カフェ情報 */}
        <div className="space-y-6">
          {/* 音声認識結果（トランスクリプション） */}
          {connectionStatus === "connected" && (
            <div className="bg-white rounded-2xl shadow-xl p-6">
              <h2 className="text-2xl font-bold text-amber-800 mb-4 flex items-center">
                🎙️ 音声認識
              </h2>
              <p className="text-sm text-gray-600 mb-4">
                リアルタイムで音声をテキスト化しています
              </p>
              {renderTranscriptions()}
            </div>
          )}

          {/* カフェ情報パネル */}
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <h2 className="text-2xl font-bold text-amber-800 mb-4 flex items-center">
              ℹ️ カフェ情報
            </h2>
            <div className="space-y-3 text-sm text-gray-700">
              <div className="flex items-center space-x-2">
                <span>📍</span>
                <span>東京都渋谷区（温かい雰囲気のカフェ）</span>
              </div>
              <div className="flex items-center space-x-2">
                <span>⏰</span>
                <span>営業時間：7:00〜22:00</span>
              </div>
              <div className="flex items-center space-x-2">
                <span>📅</span>
                <span>定休日：年中無休</span>
              </div>
              <div className="flex items-center space-x-2">
                <span>👨‍💼</span>
                <span>担当スタッフ：Patrick（パトリック）</span>
              </div>
              <div className="flex items-center space-x-2">
                <span>🤖</span>
                <span>Powered by Gemini Live API</span>
              </div>
            </div>
          </div>

          {/* 技術情報 */}
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-2xl shadow-xl p-6 border border-blue-200">
            <h2 className="text-xl font-bold text-blue-800 mb-4 flex items-center">
              🔧 技術仕様
            </h2>
            <div className="space-y-2 text-sm text-blue-700">
                              <div className="flex items-center space-x-2">
                  <span>🤖</span>
                  <span>AI Model: Gemini 2.5 Flash Live Preview Native Audio </span>
                </div>
              <div className="flex items-center space-x-2">
                <span>🌐</span>
                <span>Frontend: Next.js + Tailwind CSS</span>
              </div>
              <div className="flex items-center space-x-2">
                <span>⚡</span>
                <span>Backend: FastAPI + WebSocket</span>
              </div>
              <div className="flex items-center space-x-2">
                <span>🎵</span>
                <span>Audio: Real-time PCM Streaming</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* フッター */}
      <div className="text-center mt-12 text-gray-500 text-sm">
        <p>🎯 Google Cloud Gemini Live API デモンストレーション</p>
        <p>リアルタイム音声対話技術のハンズオン体験</p>
      </div>
    </div>
  );
}

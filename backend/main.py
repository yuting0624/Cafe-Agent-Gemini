"""
【ハンズオン教材】Starlight Cafe 音声対話システム - バックエンド

このファイルはGemini Live APIを使用したリアルタイム音声対話システムのバックエンドです。

主な機能:
1. Gemini Live APIとの連携
2. WebSocketを通じたフロントエンドとの通信  
3. リアルタイム音声ストリーミング
4. AIエージェント（Patrick）の設定とメッセージ処理

【カスタマイズポイント】
- SYSTEM_INSTRUCTION: AIエージェントの役割・性格・知識を設定
- 音声設定: VOICE_NAME, LANGUAGEで音声特性を変更
- 応答設定: temperature, top_pで応答の創造性を調整
"""

import asyncio
import base64
import json
import logging
import os
import threading
import time
import uuid
import google.auth
from dotenv import load_dotenv

from google.genai.types import (
    Part,
    Content,
    Blob,
    SpeechConfig,
    VoiceConfig,
    PrebuiltVoiceConfig,
    AudioTranscriptionConfig,
    RealtimeInputConfig,
    AutomaticActivityDetection,
    StartSensitivity,
    EndSensitivity,
    ActivityHandling,
    ProactivityConfig,
    GenerateContentConfig
)
from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.adk.agents import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.sessions.in_memory_session_service import InMemorySessionService

from fastapi import FastAPI, WebSocket
from fastapi.websockets import WebSocketState

# ===== ログ設定 =====
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# ===== 環境変数の読み込み =====
load_dotenv()

# ===== Google Cloud認証設定 =====
# プロジェクトIDを環境変数から取得
PROJECT_ID = os.environ.get('GOOGLE_CLOUD_PROJECT')
if not PROJECT_ID:
    try:
        _, PROJECT_ID = google.auth.default()
    except google.auth.exceptions.DefaultCredentialsError:
        print("❌ Google Cloud認証エラー")
        print("🔧 解決方法:")
        print("1. gcloud auth application-default login")
        print("2. または GOOGLE_CLOUD_PROJECT と GOOGLE_APPLICATION_CREDENTIALS を.envに設定")
        exit(1)

# ===== 【ハンズオン・カスタマイズ可能】基本設定 =====
LOCATION = os.environ.get('GOOGLE_CLOUD_LOCATION', 'us-central1')  # Gemini Live APIの最も安定したリージョン
VOICE_NAME = os.environ.get('VOICE_NAME', 'Puck')  # 🎯 変更可能: ["Aoede", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Zephyr"]
LANGUAGE = os.environ.get('LANGUAGE', 'Japanese')   # 🎯 変更可能: English, Japanese, Korean

# 言語コードマッピング
LANG_CODE_MAP = {
    'English': 'en-US',
    'Japanese': 'ja-JP',
    'Korean': 'ko-KR',
}
logger.info(f'LANGUAGE: {LANGUAGE}, VOICE_NAME: {VOICE_NAME}')

os.environ['GOOGLE_GENAI_USE_VERTEXAI'] = 'True'
os.environ['GOOGLE_CLOUD_PROJECT'] = PROJECT_ID
os.environ['GOOGLE_CLOUD_LOCATION'] = LOCATION

# ===== 【★重要★ ハンズオン・カスタマイズ必須】システムプロンプト =====
# 🎯 このセクションを編集して、オリジナルのAIエージェントを作成してみましょう！
# 
# 【編集のヒント】
# - 役割設定: カフェスタッフ以外（レストラン、書店、ホテルなど）にも変更可能
# - 性格設定: 親切、面白い、クール、プロフェッショナルなど
# - 専門知識: メニュー、サービス、営業情報を自由に設定
# - 対応スタイル: 丁寧語、カジュアル、方言など
#
# 【注意】システムプロンプトは応答品質に大きく影響します。
# 具体的で明確な指示を心がけましょう。

SYSTEM_INSTRUCTION = '''
あなたは「Starlight Cafe（スターライトカフェ）」の電話対応スタッフのPatrick（パトリック）です。
親切で丁寧な対応で、お客様からの電話に応対してください。

【基本設定】
* あなたの名前：Patrick（パトリック）
* カフェ名：Starlight Cafe（スターライトカフェ）
* 営業時間：7:00〜22:00（年中無休）
* 所在地：東京都渋谷区にある温かい雰囲気のカフェ

【メニュー情報】
コーヒー類：
- ドリップコーヒー（ホット/アイス）：450円
- カフェラテ：550円
- カプチーノ：550円
- エスプレッソ：350円
おすすめはカフェラテです。

フード類：
- ホットサンドイッチ：780円
- 日替わりパスタ：1,00円
- チーズケーキ：480円
- アップルパイ：520円
おすすめは日替わりパスタです。

【対応の流れ】
1. 明るく挨拶をして、カフェ名と自分の名前を名乗る
2. お客様のご用件を伺う
3. 注文の場合は、メニューの説明、注文内容の確認、お受け取り時間の調整
4. 問い合わせの場合は、丁寧に回答
5. 最後に感謝の気持ちを伝える

【対応例】
- 予約・注文受付
- メニューの説明・おすすめ
- 営業時間・アクセス案内

【注意事項】
- 常に親切で温かい対応を心がける
- 分からないことは素直に「確認いたします」と伝える
- お客様の名前を伺い、親しみやすい雰囲気を作る
- 電話対応らしい丁寧な言葉遣いを使う

【重要】会話が開始されたら、必ず最初に「お電話ありがとうございます。Starlight Cafeのパトリックと申します。本日はどのようなご用件でしょうか？」と挨拶してください。
'''

# ===== 【ハンズオン・カスタマイズ可能】AI応答設定 =====
# 🎯 これらの値を調整して、AIの応答スタイルを変更できます
AI_TEMPERATURE = 0.7  # 創造性レベル (0.0-1.0, 高いほどクリエイティブ)
AI_TOP_P = 0.8        # 応答の多様性 (0.0-1.0, 高いほど多様)

class VoicecallBackend:
    """
    音声通話バックエンドクラス
    
    Gemini Live APIとWebSocketクライアント間の橋渡しを行います。
    主な責務:
    1. Gemini Live APIセッションの管理
    2. 音声データの双方向ストリーミング
    3. エラーハンドリング
    """
    
    def __init__(self, client_websocket):
        """
        初期化
        
        Args:
            client_websocket: フロントエンドとのWebSocket接続
        """
        self.client_ws = client_websocket
        self.live_events = None
        self.live_request_queue = None

    async def create_runner(self):
        """
        Gemini Live APIランナーの作成と設定
        
        Returns:
            tuple: (live_events, live_request_queue)
        """
        logger.info("🚀 Gemini Live APIランナーを作成中...")
        
        # セッション管理サービスの初期化
        session_service = InMemorySessionService()
        
        # ===== 【ハンズオン・カスタマイズ可能】AI応答設定 =====
        generate_content_config = GenerateContentConfig(
            temperature=AI_TEMPERATURE,  # 応答の創造性
            top_p=AI_TOP_P,             # 応答の多様性
        )
        
        # ===== AIエージェントの作成 =====
        voicecall_agent = LlmAgent(
            name='starlight_cafe_agent',
            model='gemini-live-2.5-flash-preview-native-audio',
            description='Starlight Cafeの電話対応スタッフPatrickとして、お客様と親切で丁寧な音声対話を行うエージェント',
            instruction=SYSTEM_INSTRUCTION,  # システムプロンプトを適用
            generate_content_config=generate_content_config,
        )

        # ランナーの作成
        runner = Runner(
            app_name='starlight_cafe_app',
            agent=voicecall_agent,
            session_service=session_service
        )

        # セッションの作成
        session = await session_service.create_session(
            app_name='starlight_cafe_app',
            user_id='default_user',
        )

        # ===== 【ハンズオン・カスタマイズ可能】音声設定 =====
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,  # 双方向ストリーミング
            response_modalities=['AUDIO'],      # 音声応答
            speech_config=SpeechConfig(
                voice_config=VoiceConfig(
                    prebuilt_voice_config=PrebuiltVoiceConfig(
                        voice_name=VOICE_NAME  # 音声の種類
                    )
                ),
                language_code=LANG_CODE_MAP[LANGUAGE],  # 言語設定
            ),
            output_audio_transcription=AudioTranscriptionConfig(),  # 出力音声の文字起こし
            input_audio_transcription=AudioTranscriptionConfig(),   # 入力音声の文字起こし
        )

        # Live APIセッションの開始
        live_request_queue = LiveRequestQueue()
        live_events = runner.run_live(
            user_id='default_user',
            session_id=session.id,
            live_request_queue=live_request_queue,
            run_config=run_config,
        )

        logger.info("✅ Gemini Live APIランナーの作成完了")
        return live_events, live_request_queue

    async def agent_to_client_messaging(self):
        """
        AIエージェント → フロントエンド への音声データ転送
        """
        logger.info("🔊 エージェント→クライアント メッセージング開始")
        
        async for event in self.live_events:
            # イベントにコンテンツとパーツが含まれているかチェック
            if not (event.content and event.content.parts):
                continue
                
            for part in event.content.parts:
                # 音声データが含まれているかチェック
                if hasattr(part, 'inline_data') and part.inline_data:
                    audio_data = part.inline_data.data
                    mime_type = part.inline_data.mime_type
                    
                    # PCM音声データの場合のみ処理
                    if audio_data and mime_type.startswith('audio/pcm'):
                        message = {
                            'type': 'audio',
                            'data': base64.b64encode(audio_data).decode('ascii')
                        }
                        # フロントエンドに音声データを送信
                        await self.client_ws.send_text(json.dumps(message))
                
                # テキストデータ（出力トランスクリプション）のチェック
                elif hasattr(part, 'text') and part.text:
                    logger.info(f"📝 AI出力テキスト: {part.text}")
                    message = {
                        'type': 'output_transcription',
                        'text': part.text,
                        'speaker': 'AI'
                    }
                    await self.client_ws.send_text(json.dumps(message))
            
            # 入力音声の文字起こしをチェック
            if hasattr(event, 'input_transcription') and event.input_transcription:
                logger.info(f"📝 ユーザー入力テキスト: {event.input_transcription.text}")
                message = {
                    'type': 'input_transcription', 
                    'text': event.input_transcription.text,
                    'speaker': 'User'
                }
                await self.client_ws.send_text(json.dumps(message))
            
            # 出力音声の文字起こしをチェック
            if hasattr(event, 'output_transcription') and event.output_transcription:
                logger.info(f"📝 AI出力音声テキスト: {event.output_transcription.text}")
                message = {
                    'type': 'output_transcription',
                    'text': event.output_transcription.text,
                    'speaker': 'AI'
                }
                await self.client_ws.send_text(json.dumps(message))


    async def client_to_agent_messaging(self):
        """
        フロントエンド → AIエージェント への音声データ転送
        """
        logger.info("🎤 クライアント→エージェント メッセージング開始")
        
        async for message in self.client_ws.iter_text():
            try:
                message = json.loads(message)
                
                # 音声メッセージの場合のみ処理
                if message['type'] == 'audio':
                    # PCM形式の音声データかチェック
                    if not('mime_type' in message.keys() and
                            message['mime_type'] == 'audio/pcm'): 
                        continue
                    
                    # Base64デコードしてGemini Live APIに送信
                    decoded_data = base64.b64decode(message['data'])
                    self.live_request_queue.send_realtime(
                        Blob(data=decoded_data,
                             mime_type=f'audio/pcm;rate=16000')
                    )
                    logger.debug("🎤 クライアントから音声データを受信")
                    
            except Exception as e:
                logger.error(f"❌ メッセージ処理エラー: {e}")

    async def run(self):
        """
        メイン実行ループ
        
        以下の処理を並行して実行:
        1. Gemini Live APIランナーの作成
        2. 会話開始トリガーの送信
        3. 双方向音声ストリーミングの開始
        """
        logger.info('🎬 音声対話セッション開始')
        
        # Gemini Live APIランナーの作成
        self.live_events, self.live_request_queue = await self.create_runner() 

        # 会話開始のトリガー送信
        await asyncio.sleep(2)
        logger.info("📞 会話開始トリガーを送信")
        content = Content(role='user', parts=[Part(text='電話がかかってきました。')])
        self.live_request_queue.send_content(content=content)

        try:
            # 双方向音声ストリーミングの開始
            agent_to_client_task = asyncio.create_task(
                self.agent_to_client_messaging()
            )
            # voice client to agent
            client_to_agent_task = asyncio.create_task(
                self.client_to_agent_messaging()
            )
            tasks = [
                agent_to_client_task, client_to_agent_task,
            ]
            done, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            
        except Exception as e:
            logger.info(f'exception: {e}')

        logger.info('end conversation')


app = FastAPI()


# Cloud Run health-check
@app.get('/')
async def read_root():
    return {'status': 'ok'}


@app.websocket('/ws')
async def handler(websocket: WebSocket):
    await websocket.accept()
    
    try:
        # VoicecallBackendインスタンスを作成して実行
        backend = VoicecallBackend(websocket)
        await backend.run()
        
    except Exception as e:
        logger.error(f"❌ WebSocketセッションエラー: {e}")
    
    finally:
        logger.info("🔌 WebSocket接続が終了しました")

# ===== 開発用サーバー起動 =====
if __name__ == '__main__':
    import uvicorn
    logger.info("🚀 開発サーバーを起動中...")
    logger.info("📍 URL: http://localhost:8081")
    logger.info("🔗 WebSocket: ws://localhost:8081/ws")
    
    uvicorn.run(
        'main:app', 
        host='localhost', 
        port=8081,
        reload=True, 
        log_level='info'
    )


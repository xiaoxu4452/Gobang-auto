import logging
from abc import abstractmethod
from typing import Optional, Dict, Any
from typing import Tuple, List

import numpy as np

from src.engine.algorithm.algorithm import AlgorithmEngine
from src.engine.algorithm.katago.katago_gtp_engine import KataGoGTPEngine
from src.engine.board import ChessBoard, BLACK, MoveItem, WHITE


class AIEngine:
    """分析引擎抽象基类"""

    @abstractmethod
    def initialize(self, config: dict = None) -> bool:
        """初始化分析引擎"""
        pass

    @abstractmethod
    def analyze(self, board: np.ndarray, player: int = 1) -> Tuple[Optional[Tuple[int, int]], dict]:
        """
        分析棋盘并返回最佳落子位置

        参数:
            board: 15x15的棋盘状态
            player: 当前玩家 (1=黑, 2=白)

        返回:
            best_move: 最佳落子位置 (row, col)
            analysis_info: 分析信息，如评分、备选落子等
        """
        pass

    @abstractmethod
    def get_engine_info(self) -> dict:
        """获取引擎信息"""
        pass

    @abstractmethod
    def close(self):
        """关闭引擎"""
        pass


class KatagoEngine:
    """
    basicRule=FREESTYLE,RENJU,STANDARD
    "initialStones": [
        ["B", "Q4"],
        ["B", "C4"]
    ],
15  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
14  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
13  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
12  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
11  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
10  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 9  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 8  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 7  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 6  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 5  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 4  .  .  .  #  .  .  .  .  .  .  .  .  .  .  .
 3  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 2  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
    A  B  C  D  E  F  G  H  J  K  L  M  N  O  P
    """

    def __init__(self):
        self.board = None
        self.instance: AlgorithmEngine = None

    def initialize(self, config: Dict[str, Any] = None) -> bool:
        if config is None:
            config = {}

        katago_path = config.get('katago_path')
        model_path = config.get('model_path')
        config_path = config.get('config_path')
        rule = config.get('rule')
        board_size = config.get('board_size')
        rule_configs = {
            'FREESTYLE': "basicRule=FREESTYLE",
            'RENJU': "basicRule=RENJU",
            'STANDARD': "basicRule=STANDARD"
        }
        additional_args = ["-override-config", rule_configs.get(rule, "basicRule=RENJU")]

        try:
            katago = KataGoGTPEngine(
                katago_path=katago_path,
                config_path=config_path,
                model_path=model_path,
                additional_args=additional_args,
                board_size=board_size,
                config=config,
            )
            self.instance = katago
        except Exception as e:
            logging.info(f"Failed to initialize KataGo: {e}")
            return False

        return True

    def analyze(self, board: ChessBoard) -> Tuple[str, List[MoveItem], Dict[str, Any]]:
        try:
            logging.info(f"\nThis request is for the status of the chessboard:\n{board.render_numpy_board()}")

            initial_player = "PASS"
            play = board.determine_current_player()
            if play == BLACK:
                initial_player = "b"
            elif play == WHITE:
                initial_player = "w"
            current_player, best_move_list, analysis_result = self.instance.query(initial_board=board, initial_player=initial_player)
            return current_player, best_move_list, analysis_result

        except Exception as e:
            logging.error(f"Analysis failed: {e}")
            return "PASS", [], {}

    def get_engine_info(self) -> Dict[str, Any]:
        return {
            'name': 'KataGo',
            'version': '1.0',
            'supported_rules': ['FREESTYLE', 'RENJU', 'STANDARD']
        }

    def close(self):
        if self.instance:
            self.instance.close()


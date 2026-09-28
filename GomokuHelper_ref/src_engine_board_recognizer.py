from abc import ABC, abstractmethod
from typing import Optional, Tuple

import cv2
import numpy as np

from src.engine.board import ChessBoard, BLACK, WHITE


class BoardRecognizer(ABC):
    """棋盘识别抽象基类"""

    @abstractmethod
    def initialize(self, model_path: Optional[str] = None, config: dict = None) -> bool:
        """初始化识别器"""
        pass

    @abstractmethod
    def recognize(self, image: np.ndarray) -> Tuple[Optional[ChessBoard], dict]:
        """
        识别棋盘状态

        返回:
            board_state: 15x15的numpy数组，0=空, 1=黑子, 2=白子
            meta_info: 包含识别置信度等元信息
        """
        pass

    @abstractmethod
    def get_recognizer_info(self) -> dict:
        """获取识别器信息"""
        pass


class AdvancedBoardRecognizer(BoardRecognizer):
    def __init__(self):
        self.initialized = False
        self.config = {}
        self.info = {
            "name": "Precise Parameter-based Board Recognizer",
            "version": "1.0",
            "parameters": self.config.copy()
        }
        self.intersection_points = None

    def initialize(self, model_path: Optional[str] = None, config: dict = None) -> bool:
        if config:
            self.config.update(config)
            self.info["parameters"] = self.config.copy()

        self._calculate_intersection_points()
        self.initialized = True
        return True

    def _calculate_intersection_points(self):
        grid_size = self.config["grid_size"]
        cell_size = self.config["cell_size"]
        piece_radius = self.config["piece_size"] / 2

        start = piece_radius

        self.intersection_points = np.zeros((grid_size, grid_size, 2), dtype=np.int32)

        for i in range(grid_size):
            for j in range(grid_size):
                x = int(start + j * cell_size)
                y = int(start + i * cell_size)
                self.intersection_points[i, j] = (x, y)

    def recognize(self, image: np.ndarray) -> Tuple[Optional[ChessBoard], dict]:
        if not self.initialized:
            return None, {"confidence": 0.0, "error": "Recognizer not initialized"}

        if image.shape[0] != self.config["image_size"] or image.shape[1] != self.config["image_size"]:
            return None, {"confidence": 0.0,
                          "error": f"Image size must be {self.config['image_size']}x{self.config['image_size']}"}

        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image

            board_size = self.config["grid_size"]
            board_state = ChessBoard(size=board_size)
            total_confidence = 0.0
            piece_count = 0

            roi_radius = int(self.config["piece_size"] * 0.4)
            for i in range(self.config["grid_size"]):
                for j in range(self.config["grid_size"]):
                    x, y = self.intersection_points[i, j]
                    roi = self._get_roi(gray, (x, y), roi_radius)
                    if roi.size == 0:
                        continue

                    avg_brightness = np.mean(roi) / 255.0

                    if avg_brightness < self.config["black_threshold"]:
                        board_state.place_piece(i, j, BLACK)
                        total_confidence += 0.95
                        piece_count += 1
                    elif avg_brightness > self.config["white_threshold"]:
                        board_state.place_piece(i, j, WHITE)
                        total_confidence += 0.95
                        piece_count += 1

            total_cells = board_size * board_size
            avg_confidence = total_confidence / total_cells if total_cells > 0 else 0

            meta_info = {
                "confidence": round(avg_confidence, 3),
                "piece_count": board_state.count_pieces(BLACK) + board_state.count_pieces(WHITE),
                "black_count": board_state.count_pieces(BLACK),
                "white_count": board_state.count_pieces(WHITE),
                "image_size": (image.shape[1], image.shape[0]),
                "parameters_used": self.config.copy()
            }

            return board_state, meta_info

        except Exception as e:
            return None, {"confidence": 0.0, "error": str(e)}

    def _get_roi(self, image: np.ndarray, center: Tuple[int, int], radius: int) -> np.ndarray:
        x, y = center
        height, width = image.shape[:2]

        x1 = max(0, x - radius)
        x2 = min(width, x + radius + 1)
        y1 = max(0, y - radius)
        y2 = min(height, y + radius + 1)

        return image[y1:y2, x1:x2]

    def get_recognizer_info(self) -> dict:
        return self.info


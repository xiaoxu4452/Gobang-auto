# Assistant module - models.

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

@dataclass(frozen=True)
class BoardGeometry:
    x_lines: np.ndarray
    y_lines: np.ndarray
    confidence: float
    source: str = "auto"
    screen_left: int = 0
    screen_top: int = 0

    @property
    def size(self) -> int:
        return int(len(self.x_lines))

    @property
    def bounds(self) -> tuple[int, int, int, int]:
        return (
            int(round(float(self.x_lines[0]))),
            int(round(float(self.y_lines[0]))),
            int(round(float(self.x_lines[-1]))),
            int(round(float(self.y_lines[-1]))),
        )

    @property
    def spacing(self) -> float:
        dx = float(np.median(np.diff(self.x_lines)))
        dy = float(np.median(np.diff(self.y_lines)))
        return (dx + dy) / 2.0

    def screen_point(self, row: int, col: int) -> tuple[int, int]:
        return (
            self.screen_left + int(round(float(self.x_lines[col]))),
            self.screen_top + int(round(float(self.y_lines[row]))),
        )

@dataclass
class ScanResult:
    image_rgb: np.ndarray
    geometry: BoardGeometry
    board: np.ndarray
    stone_confidence: np.ndarray
    
    grid_liveness: float = 1.0

    @property
    def signature(self) -> bytes:
        return self.board.astype(np.int8, copy=False).tobytes()

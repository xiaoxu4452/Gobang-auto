# Assistant module - engine.

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

EMPTY = 0
BLACK = 1
WHITE = -1

_DIRECTIONS = ((1, 0), (0, 1), (1, 1), (1, -1))
_WIN_SCORE = 20_000_000
_PATTERN_SCORES: dict[str, int] = {
    "11111": _WIN_SCORE,
    "011110": 1_800_000,
    "211110": 260_000,
    "011112": 260_000,
    "11110": 260_000,
    "01111": 260_000,
    "11101": 260_000,
    "11011": 260_000,
    "10111": 260_000,
    "01110": 62_000,
    "010110": 62_000,
    "011010": 62_000,
    "0011100": 9_000,
    "01010": 9_000,
    "01100": 9_000,
    "00110": 9_000,
    "001100": 2_400,
    "010100": 2_400,
    "001010": 2_400,
    "00100": 280,
    "01000": 280,
}
_PATTERN_LENGTHS = tuple(sorted({len(pattern) for pattern in _PATTERN_SCORES}))
_PATTERN_RADIUS = max(_PATTERN_LENGTHS) - 1

@dataclass(frozen=True)
class MoveAnalysis:
    row: int
    col: int
    score: float
    reason: str

class GomokuEngine:
    def __init__(self, search_width: int = 16) -> None:
        self.search_width = max(8, search_width)

    @staticmethod
    def winner(board: np.ndarray) -> int:
        board = GomokuEngine._validated_board(board, require_square=False)
        return GomokuEngine._winner_unchecked(board)

    @staticmethod
    def _winner_unchecked(board: np.ndarray) -> int:
        rows, cols = board.shape
        for row in range(rows):
            for col in range(cols):
                player = int(board[row, col])
                if player == EMPTY:
                    continue
                for dr, dc in _DIRECTIONS:
                    end_row, end_col = row + dr * 4, col + dc * 4
                    if not (0 <= end_row < rows and 0 <= end_col < cols):
                        continue
                    if all(board[row + dr * step, col + dc * step] == player for step in range(1, 5)):
                        return player
        return EMPTY

    @staticmethod
    def _validated_board(board: np.ndarray, *, require_square: bool = True) -> np.ndarray:
        array = np.asarray(board)
        if array.ndim != 2 or 0 in array.shape:
            raise ValueError("棋盘必须是非空二维数组")
        if require_square and array.shape[0] != array.shape[1]:
            raise ValueError("棋盘必须是方形二维数组")
        if not np.all(np.isin(array, (WHITE, EMPTY, BLACK))):
            raise ValueError("棋盘只能包含 WHITE、EMPTY 或 BLACK")
        return array.astype(np.int8, copy=False)

    @staticmethod
    def _line_after_move(board: np.ndarray, row: int, col: int, player: int, dr: int, dc: int) -> str:
        chars: list[str] = []
        size = board.shape[0]
        for offset in range(-5, 6):
            r, c = row + dr * offset, col + dc * offset
            if not (0 <= r < size and 0 <= c < size):
                chars.append("2")
                continue
            value = player if (r == row and c == col) else int(board[r, c])
            chars.append("1" if value == player else "0" if value == EMPTY else "2")
        return "".join(chars)

    @staticmethod
    def _direction_score(line: str) -> int:
        """Return the best pattern that actually contains the move at index 5."""
        center = 5
        best = 0
        for length in _PATTERN_LENGTHS:
            first = max(0, center - length + 1)
            last = min(center, len(line) - length)
            for start in range(first, last + 1):
                best = max(best, _PATTERN_SCORES.get(line[start : start + length], 0))
        return best

    def move_score(self, board: np.ndarray, row: int, col: int, player: int) -> int:
        if board[row, col] != EMPTY:
            return -1
        total = 0
        major_threats = 0
        for dr, dc in _DIRECTIONS:
            line = self._line_after_move(board, row, col, player, dr, dc)
            direction_score = self._direction_score(line)
            total += direction_score
            if direction_score >= 62_000:
                major_threats += 1
        if major_threats >= 2 and total < 20_000_000:
            total += 420_000 * major_threats
        center = (board.shape[0] - 1) / 2
        total += max(0, int(24 - (abs(row - center) + abs(col - center)) * 2))
        return total

    @staticmethod
    def _is_winning_move(board: np.ndarray, row: int, col: int, player: int) -> bool:
        if board[row, col] != EMPTY:
            return False
        size = board.shape[0]
        for dr, dc in _DIRECTIONS:
            run = 1
            for sign in (-1, 1):
                r, c = row + dr * sign, col + dc * sign
                while 0 <= r < size and 0 <= c < size and board[r, c] == player:
                    run += 1
                    r += dr * sign
                    c += dc * sign
            if run >= 5:
                return True
        return False

    def _winning_moves(
        self,
        board: np.ndarray,
        player: int,
        *,
        limit: int | None = None,
    ) -> list[tuple[int, int]]:
        wins: list[tuple[int, int]] = []
        for row, col in self._candidate_cells(board, distance=1):
            if self._is_winning_move(board, row, col, player):
                wins.append((row, col))
                if limit is not None and len(wins) >= limit:
                    break
        return wins

    def _forced_win_creators(
        self,
        board: np.ndarray,
        player: int,
        candidates: list[tuple[int, int]],
    ) -> list[tuple[int, int]]:
        forcing: list[tuple[int, int]] = []
        for row, col in candidates:
            if self.move_score(board, row, col, player) < 260_000:
                continue
            next_board = board.copy()
            next_board[row, col] = player
            if len(self._winning_moves(next_board, player, limit=2)) >= 2:
                forcing.append((row, col))
        return forcing

    @staticmethod
    def _candidate_cells(board: np.ndarray, distance: int = 2) -> list[tuple[int, int]]:
        occupied = np.argwhere(board != EMPTY)
        size = board.shape[0]
        if len(occupied) == 0:
            center = size // 2
            return [(center, center)]
        cells: set[tuple[int, int]] = set()
        for row, col in occupied:
            for dr in range(-distance, distance + 1):
                for dc in range(-distance, distance + 1):
                    r, c = int(row + dr), int(col + dc)
                    if 0 <= r < size and 0 <= c < size and board[r, c] == EMPTY:
                        cells.add((r, c))
        center = (size - 1) / 2
        return sorted(cells, key=lambda rc: (abs(rc[0] - center) + abs(rc[1] - center), rc[0], rc[1]))

    def _rank_cells(
        self,
        board: np.ndarray,
        player: int,
        cells: list[tuple[int, int]] | set[tuple[int, int]],
        limit: int,
    ) -> list[tuple[int, int, float]]:
        ranked = []
        for row, col in cells:
            if board[row, col] != EMPTY:
                continue
            attack = self.move_score(board, row, col, player)
            defense = self.move_score(board, row, col, -player)
            ranked.append((row, col, attack + 1.12 * defense))
        center = (board.shape[0] - 1) / 2
        ranked.sort(
            key=lambda item: (-item[2], abs(item[0] - center) + abs(item[1] - center), item[0], item[1])
        )
        return ranked[:limit]

    def _rank(self, board: np.ndarray, player: int, limit: int) -> list[tuple[int, int, float]]:
        return self._rank_cells(board, player, self._candidate_cells(board), limit)

    def _rank_attacks(
        self,
        board: np.ndarray,
        player: int,
        cells: list[tuple[int, int]] | set[tuple[int, int]],
        limit: int,
    ) -> list[tuple[int, int, float]]:
        ranked = [
            (row, col, float(self.move_score(board, row, col, player)))
            for row, col in cells
            if board[row, col] == EMPTY
        ]
        center = (board.shape[0] - 1) / 2
        ranked.sort(
            key=lambda item: (-item[2], abs(item[0] - center) + abs(item[1] - center), item[0], item[1])
        )
        return ranked[:limit]

    @staticmethod
    def _affected_cells(board: np.ndarray, row: int, col: int) -> set[tuple[int, int]]:
        """Cells whose line score can change after a stone is placed at row, col."""
        size = board.shape[0]
        cells: set[tuple[int, int]] = set()
        for dr, dc in _DIRECTIONS:
            for offset in range(-_PATTERN_RADIUS, _PATTERN_RADIUS + 1):
                r, c = row + dr * offset, col + dc * offset
                if 0 <= r < size and 0 <= c < size and board[r, c] == EMPTY:
                    cells.add((r, c))
        return cells

    def _position_value(
        self,
        board: np.ndarray,
        player: int,
        cells: list[tuple[int, int]] | set[tuple[int, int]] | None = None,
    ) -> float:
        evaluation_cells = self._candidate_cells(board) if cells is None else cells
        own = self._rank_attacks(board, player, evaluation_cells, 3)
        opponent = self._rank_attacks(board, -player, evaluation_cells, 3)
        own_value = sum(item[2] * weight for item, weight in zip(own, (1.0, 0.32, 0.10)))
        opponent_value = sum(item[2] * weight for item, weight in zip(opponent, (1.0, 0.32, 0.10)))
        return own_value - 1.08 * opponent_value

    def analyze(self, board: np.ndarray, player: int) -> MoveAnalysis:
        board = self._validated_board(board)
        if player not in (BLACK, WHITE):
            raise ValueError("player 必须是 BLACK 或 WHITE")
        if self._winner_unchecked(board) != EMPTY:
            raise ValueError("棋局已经结束")
        if not np.any(board == EMPTY):
            raise ValueError("棋盘已满")

        candidates = self._candidate_cells(board)
        for row, col in candidates:
            if self.move_score(board, row, col, player) >= _WIN_SCORE:
                return MoveAnalysis(row, col, _WIN_SCORE, "直接成五")
        winning_blocks = [
            (row, col) for row, col in candidates if self.move_score(board, row, col, -player) >= _WIN_SCORE
        ]
        if winning_blocks:
            row, col = max(winning_blocks, key=lambda rc: self.move_score(board, rc[0], rc[1], player))
            return MoveAnalysis(row, col, 19_000_000, "阻挡对方成五")

        forced_wins = self._forced_win_creators(board, player, candidates)
        if forced_wins:
            row, col = max(forced_wins, key=lambda rc: self.move_score(board, rc[0], rc[1], player))
            return MoveAnalysis(row, col, 18_500_000, "制造无法同时阻挡的双威胁")

        opponent_forcing = self._forced_win_creators(board, -player, candidates)
        if opponent_forcing:
            defenses: list[tuple[int, int, int, int]] = []
            for row, col in opponent_forcing:
                defended_board = board.copy()
                defended_board[row, col] = player
                remaining = len(
                    self._forced_win_creators(
                        defended_board,
                        -player,
                        self._candidate_cells(defended_board),
                    )
                )
                defenses.append((remaining, -self.move_score(board, row, col, player), row, col))
            _, _, row, col = min(defenses)
            return MoveAnalysis(row, col, 18_000_000, "阻挡对方的双威胁")

        best: MoveAnalysis | None = None
        for row, col, base_score in self._rank(board, player, self.search_width):
            next_board = board.copy()
            next_board[row, col] = player
            replies = self._rank(next_board, -player, min(12, self.search_width))
            continuations = self._rank(next_board, player, min(12, self.search_width))
            stable_cells = {(item[0], item[1]) for item in replies + continuations}
            worst_value = float("inf")
            for reply_row, reply_col, _ in replies:
                reply_board = next_board.copy()
                reply_board[reply_row, reply_col] = -player
                if self._winner_unchecked(reply_board) == -player:
                    value = -18_000_000.0
                else:
                    affected = self._affected_cells(reply_board, reply_row, reply_col)
                    value = self._position_value(reply_board, player, stable_cells | affected)
                worst_value = min(worst_value, value)
            if not replies:
                worst_value = self._position_value(next_board, player)
            value = base_score * 0.42 + worst_value
            if best is None or value > best.score:
                best = MoveAnalysis(row, col, value, "两层攻防搜索")
        if best is None:
            raise ValueError("没有可用落点")
        return best

    def best_move(self, board: np.ndarray, player: int) -> tuple[int, int]:
        analysis = self.analyze(board, player)
        return analysis.row, analysis.col

import hashlib
import logging
from dataclasses import dataclass

import numpy as np
from typing import Optional, Tuple, List

BLACK = 1
WHITE = 2


class ChessBoard:
    def __init__(self, size: int = 15, board: np.array = None):
        self.size = size
        if board is not None:
            self.board = board
        else:
            self.board = np.zeros((size, size), dtype=int)

    def equals(self, other: 'ChessBoard') -> bool:
        """
        判断当前棋盘与传入的另一个棋盘是否完全一致
        """
        if self.size != other.size:
            return False
        return np.array_equal(self.board, other.board)

    def reset(self) -> None:
        self.board = np.zeros((self.size, self.size), dtype=int)

    def place_piece(self, row: int, col: int, chess: int) -> bool:
        if not (0 <= row < self.size and 0 <= col < self.size):
            return False

        if self.board[row, col] != 0:
            return False

        self.board[row, col] = chess
        return True

    def remove_piece(self, row: int, col: int) -> bool:
        if not (0 <= row < self.size and 0 <= col < self.size):
            return False

        if self.board[row, col] == 0:
            return False

        self.board[row, col] = 0
        return True

    def get_piece(self, row: int, col: int) -> int:
        if not (0 <= row < self.size and 0 <= col < self.size):
            return -1

        return self.board[row, col]

    def is_valid_position(self, row: int, col: int) -> bool:
        return 0 <= row < self.size and 0 <= col < self.size

    def get_board(self) -> np.ndarray:
        return self.board.copy()

    def set_board(self, new_board: np.ndarray) -> bool:
        if new_board.shape != (self.size, self.size):
            return False

        self.board = new_board.copy()
        return True

    def count_pieces(self, chess: Optional[int] = None) -> int:
        if chess is None:
            return np.count_nonzero(self.board)
        else:
            return np.count_nonzero(self.board == chess)

    def is_effective_chessboard(self) -> bool:
        count1 = np.count_nonzero(self.board == WHITE)
        count2 = np.count_nonzero(self.board == BLACK)
        return abs(count1 - count2) <= 1 and count2 >= count1

    def find_pieces(self, player: int) -> List[Tuple[int, int]]:
        positions = []
        for i in range(self.size):
            for j in range(self.size):
                if self.board[i, j] == player:
                    positions.append((i, j))
        return positions

    def save_to_file(self, filename: str) -> None:
        np.save(filename, self.board)

    def load_from_file(self, filename: str) -> bool:
        try:
            loaded_board = np.load(filename)
            if loaded_board.shape == (self.size, self.size):
                self.board = loaded_board
                return True
            else:
                logging.info(
                    f"The size of the chessboard does not match. expect: {self.size}x{self.size}，actual: {loaded_board.shape}")
                return False
        except FileNotFoundError:
            logging.info(f"File not found: {filename}")
            return False
        except Exception as e:
            logging.info(f"Error loading chessboard:{e}")
            return False

    def determine_current_player(self) -> int:
        board_state = self.board
        if board_state.shape != (self.size, self.size):
            raise ValueError(f"The chessboard must be a {self.size}x{self.size} numpy array")

        black_count = np.sum(board_state == BLACK)
        white_count = np.sum(board_state == WHITE)

        if white_count > black_count:
            raise ValueError(
                f"Invalid chessboard state: There are more white({white_count}) chess than black({black_count}) chess")
        if black_count - white_count > 1:
            raise ValueError(
                f"Invalid Chessboard State: Black Chess ({black_count}) has more than 1 more than White Chess ({white_count})")

        if black_count == white_count:
            return BLACK
        else:
            return WHITE

    def render_numpy_board(self):
        """生成棋盘字符串：列标题 + 倒序行号（15到1） + 保持数组原始顺序的内容"""
        board_str = []

        col_titles = []
        for i in range(15):
            if i < 8:
                col_titles.append(chr(ord('A') + i))
            else:
                col_titles.append(chr(ord('A') + i + 1))

        board_str.append(f"    {' '.join(col_titles)}")

        for display_row_num in range(self.size, 0, -1):

            array_index = self.size - display_row_num
            formatted_row_num = f"{display_row_num:2d}"

            row_chars = []
            for val in self.board[array_index]:
                if val == 1:
                    row_chars.append('X')
                elif val == 2:
                    row_chars.append('O')
                else:
                    row_chars.append('.')

            board_str.append(f"{formatted_row_num}  {' '.join(row_chars)}")

        return '\n'.join(board_str)

    def get_size(self) -> int:
        return self.board.shape[0]

    def diff(self, other: 'ChessBoard') -> list:
        """
        比较当前棋盘与另一个棋盘的差异。
        返回一个列表，列表中的每个元素是一个元组，格式为(棋子颜色, 位置坐标)，
        表示该位置在一个棋盘上有棋子，而在另一个棋盘上没有。
        """
        if self.size != other.size:
            raise ValueError("Two chessboards of different sizes")

        differences = []
        for i in range(self.size):
            for j in range(self.size):
                if self.board[i, j] != 0 and other.board[i, j] == 0:
                    differences.append((self.board[i, j], (i, j)))
                elif self.board[i, j] == 0 and other.board[i, j] != 0:
                    differences.append((other.board[i, j], (i, j)))
        return differences

    def has_extra_pieces(self, other: 'ChessBoard') -> bool:
        """
        检查是否存在某个位置，在另一个棋盘上有棋子，而在当前棋盘上没有棋子。
        存在返回True，不存在返回False。
        """
        if self.size != other.size:
            raise ValueError("Two chessboards of different sizes")

        for i in range(self.size):
            for j in range(self.size):
                if other.board[i, j] != 0 and self.board[i, j] == 0:
                    return True
        return False

    def is_game_over(self) -> int:
        """
        判断当前棋局是否结束
        返回值:
            0 - 游戏未结束
            BLACK(1) - 黑方获胜
            WHITE(2) - 白方获胜
        """
        # 检查所有可能的位置
        for i in range(self.size):
            for j in range(self.size):
                if self.board[i, j] == 0:
                    continue

                current_color = self.board[i, j]

                if j + 4 < self.size:
                    if (self.board[i, j + 1] == current_color and
                            self.board[i, j + 2] == current_color and
                            self.board[i, j + 3] == current_color and
                            self.board[i, j + 4] == current_color):
                        return current_color

                if i + 4 < self.size:
                    if (self.board[i + 1, j] == current_color and
                            self.board[i + 2, j] == current_color and
                            self.board[i + 3, j] == current_color and
                            self.board[i + 4, j] == current_color):
                        return current_color

                if i + 4 < self.size and j + 4 < self.size:
                    if (self.board[i + 1, j + 1] == current_color and
                            self.board[i + 2, j + 2] == current_color and
                            self.board[i + 3, j + 3] == current_color and
                            self.board[i + 4, j + 4] == current_color):
                        return current_color

                if i + 4 < self.size and j - 4 >= 0:
                    if (self.board[i + 1, j - 1] == current_color and
                            self.board[i + 2, j - 2] == current_color and
                            self.board[i + 3, j - 3] == current_color and
                            self.board[i + 4, j - 4] == current_color):
                        return current_color

        if np.count_nonzero(self.board) == self.size * self.size:
            return -1

        return 0

    def is_empty(self) -> bool:
        """
        判断当前棋盘是否为空（无任何落子）,如果棋盘为空（所有位置都是0）则返回True，否则返回False
        """
        return np.all(self.board == 0)

    def get_hash(self) -> str:
        """
        生成当前棋盘状态的唯一hash值
        """
        board_bytes = self.board.tobytes()
        return hashlib.md5(board_bytes).hexdigest()


@dataclass
class MoveItem:
    move: Tuple[int, int]
    gtp: str
    visits: int
    weight: int
    winrate: float

    def __str__(self):
        return f"Move{self.move}({self.gtp}): v{self.visits} w{self.weight} {self.winrate:.1%}"


import json
import logging
import os
from datetime import datetime
from typing import Optional

import cv2
import numpy as np
from PIL import Image
from PyQt5.QtGui import QColor

from src.engine.board import BLACK, WHITE
from cachetools import LRUCache


def to_ndarray(image_path: str) -> Optional[np.ndarray]:
    """
    将本地图片文件转换为 Optional[np.ndarray]
    """
    try:
        if not os.path.exists(image_path):
            logging.info(f"Error: File does not exist - {image_path}")
            return None
        image = Image.open(image_path)
        if image.mode != 'RGB':
            image = image.convert('RGB')
        image_array = np.array(image)
        return image_array

    except Exception as e:
        logging.error(f"Error converting image: {e}")
        return None


def crop_ndarray(
        image: Optional[np.ndarray],
        left: int,
        top: int,
        width: int,
        height: int
) -> Optional[np.ndarray]:
    """
    根据给定的区域参数裁剪图像
    """
    # 检查输入是否为None
    if image is None:
        return None

    if not isinstance(image, np.ndarray):
        logging.info("Error: Input is not a numpy array")
        return None

    if image.ndim not in [2, 3]:
        logging.info("Error: Unsupported image dimension")
        return None

    img_height, img_width = image.shape[:2]

    if left < 0 or top < 0 or width <= 0 or height <= 0:
        logging.info("Error: Crop parameter is invalid")
        return None

    right = left + width
    bottom = top + height

    if left >= img_width or top >= img_height:
        logging.info("Error: Crop area completely beyond image boundary")
        return None

    adj_left = max(0, left)
    adj_top = max(0, top)
    adj_right = min(img_width, right)
    adj_bottom = min(img_height, bottom)
    adj_width = adj_right - adj_left
    adj_height = adj_bottom - adj_top
    if adj_width <= 0 or adj_height <= 0:
        logging.info("Error: The adjusted cropping area is invalid")
        return None
    try:
        if image.ndim == 2:
            cropped = image[adj_top:adj_bottom, adj_left:adj_right]
        else:
            cropped = image[adj_top:adj_bottom, adj_left:adj_right, :]
        return cropped
    except Exception as e:
        logging.error(f"Error cropping image: {e}")
        return None


def save_ndarray(image: Optional[np.ndarray],
                 folder_path: str,
                 filename: Optional[str] = None,
                 default_name: str = "board_image") -> bool:
    """
    将可能为空的numpy数组图像保存到本地文件夹
    """
    if image is None:
        logging.info("The image is empty and cannot be saved")
        return False

    os.makedirs(folder_path, exist_ok=True)

    if filename is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{default_name}_{timestamp}.png"
    else:
        if not filename.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.tiff')):
            filename += '.png'

    file_path = os.path.join(folder_path, filename)

    try:
        success = cv2.imwrite(file_path, image)
        if success:
            logging.info(f"The image has been successfully saved to: {file_path}")
            return True
        else:
            logging.error(f"Failed to save image: {file_path}")
            return False
    except Exception as e:
        logging.error(f"An error occurred while saving the image: {str(e)}")
        return False


def gtp_2_np(gtp, size):
    column_letter = gtp[0].upper()
    row_number = int(gtp[1:])
    if column_letter < 'I':
        col = ord(column_letter) - ord('A')
    else:
        col = ord(column_letter) - ord('A') - 1
    row = size - row_number
    return row, col


def np_to_gtp(row, col, size):
    gtp_row = size - row
    if col < 8:
        column_letter = chr(ord('A') + col)
    else:
        column_letter = chr(ord('A') + col + 1)

    return f"{column_letter}{gtp_row}"


def chess2color(chess):
    return "B" if chess == BLACK else "W" if chess == WHITE else "PASS"


def get_win_rate_color(win_rate):
    """
    根据胜率返回对应的QColor颜色对象
    """
    if win_rate * 100 > 98:
        return QColor(255, 0, 0, 200)  # 红色
    elif win_rate > 95:
        return QColor(255, 165, 0, 200)  # 橙色
    elif win_rate > 85:
        return QColor(128, 0, 128, 200)  # 紫色
    elif win_rate > 50:
        return QColor(0, 0, 255, 200)  # 蓝色
    else:
        return QColor(255, 255, 255, 200)  # 白色


class CustomEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        elif hasattr(obj, '__dict__'):
            return obj.__dict__
        return super().default(obj)


def object_to_json_with_encoder(obj, indent=None):
    return json.dumps(obj, cls=CustomEncoder, indent=indent, ensure_ascii=False)


def parse_gtp_info(gtp_output):
    """
    解析围棋GTP分析命令的输出
    """
    info_entries = gtp_output.split('info ')[1:]

    info_array = []

    for entry in info_entries:
        cleaned_entry = ' '.join(entry.split())
        info_dict = {}
        tokens = cleaned_entry.split()
        i = 0

        while i < len(tokens):
            key = tokens[i]
            if key in ['pv', 'pvVisits']:
                j = i + 1
                while j < len(tokens) and not tokens[j].isalpha():
                    j += 1
                info_dict[key] = tokens[i + 1:j]
                i = j
            else:
                info_dict[key] = tokens[i + 1] if i + 1 < len(tokens) else ""
                i += 2

        info_array.append(info_dict)

    return info_array


class AnalyzedLRUCache(LRUCache):
    """
    扩展LRUCache，增加缓存命中/未命中统计功能
    """

    def __init__(self, maxsize):
        super().__init__(maxsize)
        self.hits = 0
        self.misses = 0

    def __getitem__(self, key):
        try:
            value = super().__getitem__(key)
            self.hits += 1
            return value
        except KeyError:
            self.misses += 1
            raise

    def get(self, key, default=None):
        try:
            value = super().__getitem__(key)
            self.hits += 1
            return value
        except KeyError:
            self.misses += 1
            return default

    def get_hit_rate(self):
        total_accesses = self.hits + self.misses
        if total_accesses == 0:
            return 0.0
        return self.hits / total_accesses

    def reset_stats(self):
        self.hits = 0
        self.misses = 0

    @classmethod
    def load_from_file(cls, chess_manual_path, maxsize):
        return cls(maxsize)

    def save_to_file(self, chess_manual_path):
        pass


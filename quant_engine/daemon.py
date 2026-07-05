import sys
import os
import json
import traceback
import pandas as pd
import numpy as np
import jsonschema  # 需安装：pip install jsonschema
from typing import Any, Dict, List

# 加载协议 Schema
SCHEMA_PATH = "docs/protocol-schema.json"
PROTOCOL_SCHEMA = {}
if os.path.exists(SCHEMA_PATH):
    with open(SCHEMA_PATH, "r") as f:
        PROTOCOL_SCHEMA = json.load(f)

def validate_request(packet: Dict):
    if PROTOCOL_SCHEMA:
        # 使用 jsonschema 校验输入结构
        # 简化版：仅校验 type 和 correlationId
        jsonschema.validate(instance=packet, schema=PROTOCOL_SCHEMA["message_types"][packet["type"]]["request"])

# ... 原有计算逻辑 ...

"""数据去噪业务规则：状态流转、字段校验与筛选口径都收在这里。

与采集去重的绑定约定：去重指纹按「绑定规则编号」引用清洗规则，
规则被废弃时，仍引用它的生效指纹在同一锁内退出新接入，历史去重判定保留。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from app.store import store

MODULE = "dataclean"
FP_MODULE = "dedupfingerprint"
ENGINE_MODULE = "dedupengine"
REQUIRED_FIELDS = ["规则编号", "目标字段", "HTML标签清理"]
STATUS_ORDER = ["草稿", "规则验证中", "已启用", "已废弃"]
# 单向推进：动作 -> (允许的前置状态, 目标状态)。已废弃是终态，不允许回退。
ACTION_RULES = {
    "提交规则验证": (("草稿",), "规则验证中"),
    "启用规则": (("规则验证中",), "已启用"),
    "废弃规则": (("已启用",), "已废弃"),
}
NEGATIVE_ACTIONS = ["废弃规则"]
FP_ACTIVE = "生效中"
FP_RETIRED = "已退出"


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class DatacleanService:
    def list_entries(
        self,
        *,
        keyword: str | None = None,
        status: str | None = None,
        page: int = 1,
        size: int = 20,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = store.rows(MODULE)
        if keyword:
            rows = [row for row in rows if keyword in str(row.get("规则编号", ""))]
        if status:
            rows = [row for row in rows if row.get("status") == status]
        total = len(rows)
        start = max(page - 1, 0) * size
        return rows[start:start + size], total

    def get_entry(self, entry_id: int) -> dict[str, Any] | None:
        entry = store.find(MODULE, entry_id)
        if entry is None:
            return None
        detail = dict(entry)
        # 详情附带仍引用本规则的去重指纹，列表 -> 详情链路能看到下游影响面
        detail["引用指纹"] = [
            dict(fp)
            for fp in store.rows(FP_MODULE)
            if fp.get("绑定规则编号") == entry.get("规则编号")
        ]
        return detail

    def create_entry(self, values: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
        missing = [field for field in REQUIRED_FIELDS if not str(values.get(field) or "").strip()]
        if missing:
            return None, missing
        rows = store.rows(MODULE)
        entry = {"id": max((int(row.get("id", 0)) for row in rows), default=0) + 1}
        entry.update({field: values.get(field) for field in REQUIRED_FIELDS})
        entry["status"] = STATUS_ORDER[0]
        entry["pending"] = True
        entry["abnormal"] = False
        rows.append(entry)
        return entry, []

    def run_action(self, entry_id: int, action: str) -> tuple[dict[str, Any] | None, str, dict[str, Any] | None]:
        with store.locked():
            entry = store.find(MODULE, entry_id)
            if entry is None:
                return None, f"去噪规则 {entry_id} 不存在或已归档", None
            if action not in ACTION_RULES:
                return None, f"动作「{action}」不属于数据去噪可执行范围", None
            allowed_from, target = ACTION_RULES[action]
            current = str(entry.get("status", ""))
            if current not in allowed_from:
                # 重复提交/重复废弃在这里被拦下：状态机之外的动作一律无副作用，
                # 已退出的指纹不会被二次处理，也就不会留下孤儿指纹。
                return (
                    None,
                    f"当前状态「{current}」不允许执行「{action}」：规则只能按 "
                    f"草稿→规则验证中→已启用→已废弃 单向推进，本次操作未产生任何变更",
                    None,
                )
            extra: dict[str, Any] = {}
            if action == "废弃规则":
                extra["affected_engines"] = self._retire_bound_fingerprints(entry)
            entry["status"] = target
            entry["pending"] = target != STATUS_ORDER[-1]
            entry["abnormal"] = action in NEGATIVE_ACTIONS
            message = f"去噪规则已{action}"
            affected = extra.get("affected_engines") or []
            if affected:
                refs = "、".join(
                    f"{item['引擎编号']}（指纹 {item['指纹编号']}，滑动窗口 {item['滑动窗口天']}）"
                    for item in affected
                )
                message += f"；以下去重指纹已退出新接入：{refs}。历史去重结果保留不变"
            else:
                message += "；没有去重指纹引用该规则"
            return entry, message, extra

    def _retire_bound_fingerprints(self, entry: dict[str, Any]) -> list[dict[str, Any]]:
        """把仍引用本规则的生效指纹退出新接入（调用方已持锁，与规则写入同原子区）。

        只改状态不删记录：历史去重判定保留；重复废弃时指纹已是「已退出」，
        不会命中 FP_ACTIVE 过滤，天然幂等。
        """
        affected: list[dict[str, Any]] = []
        engines = {row.get("引擎编号"): row for row in store.rows(ENGINE_MODULE)}
        for fp in store.rows(FP_MODULE):
            if fp.get("绑定规则编号") != entry.get("规则编号"):
                continue
            if fp.get("指纹状态") != FP_ACTIVE:
                continue
            fp["指纹状态"] = FP_RETIRED
            fp["退出时间"] = _now()
            fp["退出原因"] = f"绑定清洗规则 {entry.get('规则编号')} 已废弃"
            engine = engines.get(fp.get("引擎编号"), {})
            affected.append({
                "指纹编号": fp.get("指纹编号"),
                "引擎编号": fp.get("引擎编号"),
                "字段组版本": fp.get("字段组版本"),
                "滑动窗口天": fp.get("滑动窗口天") or engine.get("滑动窗口天", ""),
            })
        return affected

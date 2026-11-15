"""采集去重业务规则：状态流转、字段校验与筛选口径都收在这里。

指纹生命周期：引擎启用时按「引擎编号 + 字段组版本 + 绑定清洗规则」登记指纹；
引擎停用或绑定规则废弃时指纹退出新接入（只改状态不删记录，历史判定保留）。
重新启用必须建立新字段组版本，旧版本指纹不允许复活。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from app.store import store

MODULE = "dedupengine"
FP_MODULE = "dedupfingerprint"
CLEAN_MODULE = "dataclean"
REQUIRED_FIELDS = ["引擎编号", "去重字段组", "哈希算法"]
STATUS_ORDER = ["草稿", "引擎评估中", "已启用", "已停用"]
# 单向推进：评估 -> 启用 -> 停用不允许回退；已停用想重新启用，
# 必须先重新提交评估，并在启用时建立新字段组版本。
ACTION_RULES = {
    "提交引擎评估": (("草稿", "已停用"), "引擎评估中"),
    "启用引擎": (("引擎评估中",), "已启用"),
    "停用引擎": (("已启用",), "已停用"),
}
NEGATIVE_ACTIONS = ["停用引擎"]
FP_ACTIVE = "生效中"
FP_RETIRED = "已退出"


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _engine_fingerprints(engine_code: str) -> list[dict[str, Any]]:
    return [fp for fp in store.rows(FP_MODULE) if fp.get("引擎编号") == engine_code]


class DedupengineService:
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
            rows = [row for row in rows if keyword in str(row.get("引擎编号", ""))]
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
        # 详情附带本引擎的指纹履历，列表 -> 详情链路能确认版本与退出原因
        detail["指纹列表"] = [dict(fp) for fp in _engine_fingerprints(str(entry.get("引擎编号", "")))]
        return detail

    def create_entry(self, values: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
        missing = [field for field in REQUIRED_FIELDS if not str(values.get(field) or "").strip()]
        if missing:
            return None, missing
        rows = store.rows(MODULE)
        entry = {"id": max((int(row.get("id", 0)) for row in rows), default=0) + 1}
        entry.update({field: values.get(field) for field in REQUIRED_FIELDS})
        entry["绑定清洗规则"] = str(values.get("绑定清洗规则") or "").strip()
        entry["字段组版本"] = 1
        entry["status"] = STATUS_ORDER[0]
        entry["pending"] = True
        entry["abnormal"] = False
        rows.append(entry)
        return entry, []

    def run_action(
        self,
        entry_id: int,
        action: str,
        values: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any] | None, str, dict[str, Any] | None]:
        values = values or {}
        with store.locked():
            entry = store.find(MODULE, entry_id)
            if entry is None:
                return None, f"去重引擎 {entry_id} 不存在或已归档", None
            if action not in ACTION_RULES:
                return None, f"动作「{action}」不属于采集去重可执行范围", None
            allowed_from, target = ACTION_RULES[action]
            current = str(entry.get("status", ""))
            if current not in allowed_from:
                # 重复停用/越级启用在这里被拦下：无副作用，指纹状态保持不变。
                return (
                    None,
                    f"当前状态「{current}」不允许执行「{action}」：引擎只能按 "
                    f"草稿/已停用→引擎评估中→已启用→已停用 单向推进，本次操作未产生任何变更",
                    None,
                )
            extra: dict[str, Any] = {}
            if action == "启用引擎":
                ok, message, extra = self._enable(entry, values)
                if not ok:
                    return None, message, extra
            elif action == "停用引擎":
                extra = self._disable(entry)
            entry["status"] = target
            entry["pending"] = target != STATUS_ORDER[-1]
            entry["abnormal"] = action in NEGATIVE_ACTIONS
            message = f"去重引擎已{action}"
            fingerprint = extra.get("fingerprint")
            if fingerprint:
                message += f"，新指纹 {fingerprint['指纹编号']} 生效（绑定规则 {fingerprint['绑定规则编号']}）"
            retired = extra.get("retired_fingerprints") or []
            if retired:
                refs = "、".join(fp["指纹编号"] for fp in retired)
                message += f"，指纹 {refs} 已退出新接入，历史去重结果保留"
            return entry, message, extra

    def _enable(
        self,
        entry: dict[str, Any],
        values: dict[str, Any],
    ) -> tuple[bool, str, dict[str, Any] | None]:
        """启用前置校验 + 指纹登记（调用方已持锁，与状态写入同原子区）。"""
        # 1. 有过指纹履历的引擎属于重新启用：必须提供更大的字段组版本，
        #    不允许静默恢复旧字段组。版本校验在前，前端可凭 need_version 补录后重试。
        history = _engine_fingerprints(str(entry.get("引擎编号", "")))
        current_version = int(entry.get("字段组版本", 1))
        new_version = current_version
        if history:
            raw = values.get("字段组版本")
            if raw is None or str(raw).strip() == "":
                return (
                    False,
                    f"重新启用必须建立新字段组版本：当前 v{current_version}，"
                    f"请提交更大的字段组版本，旧字段组不允许恢复",
                    {"need_version": True, "current_version": current_version},
                )
            try:
                new_version = int(str(raw).strip())
            except (TypeError, ValueError):
                return (
                    False,
                    f"字段组版本「{raw}」不是有效数字",
                    {"need_version": True, "current_version": current_version},
                )
            if new_version <= current_version:
                return (
                    False,
                    f"字段组版本必须大于当前版本 v{current_version}，不允许恢复旧字段组",
                    {"need_version": True, "current_version": current_version},
                )
        # 2. 绑定清洗规则必须已启用；启用时允许换绑到另一条已启用规则，
        #    否则启用会立刻留下无人引用的孤儿指纹。
        rule_code = str(values.get("绑定清洗规则") or entry.get("绑定清洗规则") or "").strip()
        rule = next(
            (row for row in store.rows(CLEAN_MODULE) if row.get("规则编号") == rule_code),
            None,
        )
        if not rule_code or rule is None:
            return False, f"绑定清洗规则 {rule_code or '(未填写)'} 不存在，无法登记去重指纹", None
        if rule.get("status") != "已启用":
            return (
                False,
                f"绑定清洗规则 {rule_code} 当前为「{rule.get('status')}」，启用引擎会留下孤儿指纹；"
                f"请先启用该规则，或在启用请求里换绑一条已启用规则",
                None,
            )
        # 3. 登记新指纹：同一 (引擎, 版本) 只可能有一条，重复启用被状态机拦在外面。
        entry["绑定清洗规则"] = rule_code
        entry["字段组版本"] = new_version
        fingerprint = {
            "id": max((int(fp.get("id", 0)) for fp in store.rows(FP_MODULE)), default=0) + 1,
            "指纹编号": f"FP-{entry.get('引擎编号')}-v{new_version}",
            "引擎编号": entry.get("引擎编号"),
            "字段组版本": new_version,
            "绑定规则编号": rule_code,
            "滑动窗口天": entry.get("滑动窗口天", ""),
            "指纹状态": FP_ACTIVE,
            "创建时间": _now(),
            "退出时间": "",
            "退出原因": "",
        }
        store.rows(FP_MODULE).append(fingerprint)
        return True, "", {"fingerprint": dict(fingerprint)}

    def _disable(self, entry: dict[str, Any]) -> dict[str, Any]:
        """停用引擎：把本引擎仍生效的指纹退出新接入（调用方已持锁）。

        指纹可能已被规则废弃先行退出，这里只处理仍是「生效中」的，
        重复停用不会产生第二条退出记录。
        """
        retired: list[dict[str, Any]] = []
        for fp in _engine_fingerprints(str(entry.get("引擎编号", ""))):
            if fp.get("指纹状态") != FP_ACTIVE:
                continue
            fp["指纹状态"] = FP_RETIRED
            fp["退出时间"] = _now()
            fp["退出原因"] = f"引擎 {entry.get('引擎编号')} 停用"
            retired.append(dict(fp))
        return {"retired_fingerprints": retired}

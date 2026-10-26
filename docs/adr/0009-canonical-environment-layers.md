---
status: accepted
---

# Canonical Environment Layers with Background Sugar

场景环境不再建模成“单独一个背景对象”，而是统一收敛为按 `LayerId` 稳定寻址的 `Environment Layer` 集合；`background` 只是其中一条保留的主背景糖衣层。这样做是因为运行时、时间线、seek/scrub 和未来的视觉目标体系都需要多层环境的一致身份模型，而不是一套单背景特例再叠补丁。

## Decisions

1. **Canonical model**: semantic source 使用 `environmentLayer` family 的 `set / transform / remove` mode；compiled runtime 使用 `setEnvironmentLayer` / `transformEnvironmentLayer` / `removeEnvironmentLayer`。`setBackground` / `transformBackground` / `removeBackground` 只允许出现在显式离线 migration 输入中，普通 loader、scheduler 和 UI 不再兼容这些 alias。`layerId: "background"` 仍是保留的主背景身份。

2. **Stable identity**: 每条环境层必须有稳定 `LayerId` 用于寻址、过渡约束、子轨归属和未来视觉目标引用；`Environment Layer Label` 只负责作者可读名称，不承担稳定身份。

3. **Author-facing UI**: 环境层统一通过可编辑的 `LayerId` 识别；时间线与效果目标选择器直接显示同一个 ID，不再以不可编辑的 `label`、资源文件名或出现顺序编号代替。`label` 保留在已有数据中，不参与环境层的显示身份。整组范围明确显示为“全部环境图层”。（2026-10-25 按作者使用反馈修订。）

4. **Spatial semantics**: 环境层坐标统一走归一化 `x / y`；`z` 保持物理深度语义，同时参与渲染前后关系与运镜/视差计算，不降级成纯排序值。

5. **Track model**: 时间线采用 `Background Track Group + Environment Layer Subtrack`；每个出现过的 `LayerId` 都有稳定子轨，顺序按首次出现保持稳定，不随当前时刻存活状态忽隐忽现。

6. **Effect references**: 单层与整组的 source 引用按 [KSM-0003 Lighting Target References](../ksm-adr/ksm-0003-semantic-scene-statements.md#lighting-target-references-scene-v5-2026-10-26) 使用结构化 target；旧字符串 ID 保持原义，编译后的字符串键不作为 source 语法。

7. **Transition truthfulness**: 同一 `LayerId` 的过渡不可重叠；seek / scrub / reconstruct 必须还原该时刻真实的中间态，包括 cross-fade 双图共存阶段和退场阶段。

## Consequences

- 运行时、编译器、编辑器和视觉目标系统可以围绕同一个环境层身份模型演进。
- 历史场景必须先经离线 migration 转换；普通产品加载路径拒绝旧背景动作。
- UI 中的单层显示与 `LayerId` 编辑项一致，作者可以直接用 ID 确认效果作用对象；“全部环境图层”单独表示整组。

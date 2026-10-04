---
status: accepted
---

# Visual Composition Model for Cinematic Authoring

这个项目要在 WebGL / PixiJS 中复刻 AE 式合成语言，但不想回到滤镜面板或节点图地狱，因此确定采用双栈视觉模型：`ObjectCompositingStack` 负责角色贴地、阴影、环境色融入等对象级融合，`LensStyleStack` 负责 grade、optics、atmosphere、texture 等整镜头统一风格；作者入口统一为 `StyleRecipe + StyleOverride`，而不是直接暴露底层滤镜参数。这样既能服务“角色融入背景”和“整体电影感”这两个不同层级的目标，又能保持默认可控、少量覆写、仍具扩展性的 authoring 体验。


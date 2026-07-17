/* ==========================================================
   人设档案数据 · 空白模板
   —— 修改这个文件即可更新整个网站的内容 ——

   本文件已清空为「空白模板」：只保留结构骨架，不含任何实际内容。
   各字段留空即可，网页会以灰色示例文字提示该处应填什么；
   进入编辑模式后，对应输入框是空的，直接填入你自己的内容即可。

   · characters    角色档案
   · relationships 关系（CP / 羁绊）档案
   · worldviews    世界观记录册
   · site          站点标题等全局文案

   头像：avatar 填图片路径（如 "img/xxx.png"）；
        留空 "" 则自动生成渐变色首字头像；
        也可在编辑模式下于关系页上传本地图片并裁剪。

   角色档案里：
   · quotes   语录，两种写法可以混用：
              { text: "……" }                           单人语录（不带说话人）
              { dialog: [ { who, text }, … ] }          角色间对话（可建多组）

   关系档案里：
   · calls    双方对彼此的称呼（键为角色ID，值为「TA怎么称呼对方」）
   · attitude 双方对彼此的表里态度（surface 表面 / inner 内心）
   · custom   自定义模块（编辑模式可新增，自动编号标题）
   ========================================================== */

/* 数据版本号：修改 data.js 的内容后改动此值，
   访客浏览器里缓存的旧数据会被自动丢弃、加载新默认数据 */
const DATA_VERSION = "2026-07-11-blank-template-2";

const SITE = {
  title: "",
  titleEn: "",
  subtitle: "",
  tags: [],
  footer: "",
};

/* ---------------- 角色档案 ---------------- */
const CHARACTERS = [
  {
    id: "role-a",
    name: "",
    en: "",
    avatar: "",
    mbti: "",
    alignment: "",
    tags: ["", "", ""],
    oneLine: "",
    profile: {},
    colors: [
      { hex: "#75B596" },
      { hex: "#438855" },
    ],
    intro: [
      { title: "", text: "" },
    ],
    quotes: [
      { text: "" },
      {
        dialog: [
          { who: "", text: "" },
          { who: "", text: "" },
        ],
      },
    ],
  },
  {
    id: "role-b",
    name: "",
    en: "",
    avatar: "",
    mbti: "",
    alignment: "",
    tags: ["", "", ""],
    oneLine: "",
    profile: {},
    colors: [
      { hex: "#5E9EAE" },
      { hex: "#EAF3F0" },
    ],
    intro: [
      { title: "", text: "" },
    ],
    quotes: [
      { text: "" },
    ],
  },
];

/* ---------------- 关系档案（CP / 羁绊） ---------------- */
const RELATIONSHIPS = [
  {
    id: "bond-1",
    title: "",
    hashtag: "",
    en: "",
    pair: ["role-a", "role-b"],
    tags: ["", ""],
    tagline: "",
    calls: {},
    attitude: {},
    before: {},
    timeline: [
      {
        era: "",
        text: "",
        bubbles: [
          { side: "a", who: "", text: "" },
          { side: "b", who: "", text: "" },
        ],
      },
    ],
    interview: [
      {
        q: "",
        answers: [
          { who: "", text: "" },
          { who: "", text: "" },
        ],
      },
    ],
    custom: [],
  },
];

/* ---------------- 世界观记录册 ---------------- */
const WORLDVIEWS = [
  {
    no: "01",
    title: "",
    subtitle: "",                 // 记录册卡片副标题（可编辑）
    brief: "",                    // 记录册卡片简介（可编辑）
    type: "",
    en: "",                       // 详情页大标题下的英文副题（大写拼音）
    accent: "#438855",            // 详情页主色（站点抹茶绿，可每册自定义）
    lead: "",
    desc: [
      "",
    ],
    sections: [
      { title: "", en: "", intro: "", entries: [] },
    ],
    /* 出场角色：留空 role 时标签自动读取角色卡中的「称号」；填了 role 即自定义标签 */
    cast: [
      { id: "role-a" },
      { id: "role-b" },
    ],
    relation: "",
  },
];

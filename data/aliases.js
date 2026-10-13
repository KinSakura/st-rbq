/**
 * 本文件由 tools/build-aliases.mjs 自动生成，请勿手改。
 * 来源：1.txt  @ 2026-10-05T00:31:05.107Z
 * 语义：把 AI 惯用的英文属性名（race/job/level/meiki…）映射到表格列下标。
 * 之所以从 rbq.js 反推而不是另编一套，是为了让现有预设产出的 <data> 语义零损失。
 */
export default {
  "generatedFrom": "1.txt",
  "generatedAt": "2026-10-05T00:31:05.107Z",
  "nameToNo": {
    "宏观时空与定调矩阵": "0",
    "地点与场景静态基建表": "1",
    "角色静态档案表": "2",
    "角色生理与阈值敏感表": "3",
    "角色即时物理与表层状态表": "4",
    "社交网络与认知盲区表": "5",
    "剧情大纲与焦点引擎表": "6",
    "驱动任务与违规契约表": "7",
    "特殊面板覆写与异变表": "8",
    "物品流通与物理资产表": "9",
    "能力法则与技战术调度表": "10",
    "派阀、律法与世界观法则联合表": "11",
    "宏观纪事录压缩封包表": "12",
    "角色动态属性表": "13",
    "怪物与临时实体属性表": "14"
  },
  "singletonTables": [
    0,
    6
  ],
  "tableAliases": {
    "0": {
      "aliasToIndex": {
        "round": 0,
        "datetime": 1,
        "location": 2,
        "weather": 3,
        "present": 4,
        "law": 5,
        "atmosphere": 6
      },
      "indexToAliases": {
        "0": [
          "round"
        ],
        "1": [
          "datetime"
        ],
        "2": [
          "location"
        ],
        "3": [
          "weather"
        ],
        "4": [
          "present"
        ],
        "5": [
          "law"
        ],
        "6": [
          "atmosphere"
        ]
      },
      "aliases": [
        "round",
        "datetime",
        "location",
        "weather",
        "present",
        "law",
        "atmosphere"
      ]
    },
    "1": {
      "aliasToIndex": {
        "name": 0,
        "region": 1,
        "scale": 2,
        "decor": 3,
        "security": 4,
        "owner": 5,
        "func": 6,
        "assets": 7,
        "clues": 8,
        "damage": 9
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "region"
        ],
        "2": [
          "scale"
        ],
        "3": [
          "decor"
        ],
        "4": [
          "security"
        ],
        "5": [
          "owner"
        ],
        "6": [
          "func"
        ],
        "7": [
          "assets"
        ],
        "8": [
          "clues"
        ],
        "9": [
          "damage"
        ]
      },
      "aliases": [
        "name",
        "region",
        "scale",
        "decor",
        "security",
        "owner",
        "func",
        "assets",
        "clues",
        "damage"
      ]
    },
    "2": {
      "aliasToIndex": {
        "name": 0,
        "alive": 1,
        "race": 2,
        "job": 3,
        "level": 4,
        "skillPool": 5,
        "age": 6,
        "birthday": 7,
        "personality": 8,
        "taboo": 9,
        "preference": 10,
        "background": 11,
        "weakness": 12,
        "growth": 13,
        "statPref": 14
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "alive"
        ],
        "2": [
          "race"
        ],
        "3": [
          "job"
        ],
        "4": [
          "level"
        ],
        "5": [
          "skillPool"
        ],
        "6": [
          "age"
        ],
        "7": [
          "birthday"
        ],
        "8": [
          "personality"
        ],
        "9": [
          "taboo"
        ],
        "10": [
          "preference"
        ],
        "11": [
          "background"
        ],
        "12": [
          "weakness"
        ],
        "13": [
          "growth"
        ],
        "14": [
          "statPref"
        ]
      },
      "aliases": [
        "name",
        "alive",
        "race",
        "job",
        "level",
        "skillPool",
        "age",
        "birthday",
        "personality",
        "taboo",
        "preference",
        "background",
        "weakness",
        "growth",
        "statPref"
      ]
    },
 "3": {
      "aliasToIndex": {
        "looks": 5,
        "face": 5,
        "appearance_desc": 5,
        "look": 5,
        "容貌描述": 5,
        "容貌": 5,
        "外貌": 5,
        "长相": 5,
        "样貌": 5,
        "面孔": 5,

        "name": 0,
        "gender": 1,
        "height": 2,
        "weight": 3,
        "measures": 4,
        "overallFigure": 6,
        "shoulderCollarbone": 7,
        "chest": 8,
        "waist": 9,
        "hip": 10,
        "hands": 11,
        "legs": 12,
        "feet": 13,
        "hairColor": 14,
        "hairStyle": 15,
        "bodyHair": 16,
        "scent": 17,
        "sexExp": 18,
        "meiki": 19,
        "organ": 20,
        "anus": 21,
        "period": 22,
        "painThreshold": 23,
        "pleasureThreshold": 24,
        "kink": 25,
        "situationPref": 26,
        "sexTaboo": 27,
        "stamina": 28,
        "exhaustion": 29,
        "scar": 30
      },
      "indexToAliases": {
      "5": ["looks","face","appearance_desc","look","容貌描述","容貌","外貌","长相","样貌","面孔"],
 "0": [
          "name"
        ],
 "1": [
          "gender"
        ],
 "2": [
          "height"
        ],
 "3": [
          "weight"
        ],
 "4": [
          "measures"
        ],
 "6": [
          "overallFigure"
        ],
 "7": [
          "shoulderCollarbone"
        ],
 "8": [
          "chest"
        ],
 "9": [
          "waist"
        ],
 "10": [
          "hip"
        ],
 "11": [
          "hands"
        ],
 "12": [
          "legs"
        ],
 "13": [
          "feet"
        ],
 "14": [
          "hairColor"
        ],
 "15": [
          "hairStyle"
        ],
 "16": [
          "bodyHair"
        ],
 "17": [
          "scent"
        ],
 "18": [
          "sexExp"
        ],
 "19": [
          "meiki"
        ],
 "20": [
          "organ"
        ],
 "21": [
          "anus"
        ],
 "22": [
          "period"
        ],
 "23": [
          "painThreshold"
        ],
 "24": [
          "pleasureThreshold"
        ],
 "25": [
          "kink"
        ],
 "26": [
          "situationPref"
        ],
 "27": [
          "sexTaboo"
        ],
 "28": [
          "stamina"
        ],
 "29": [
          "exhaustion"
        ],
 "30": [
          "scar"
        ]
      },
      "aliases": [
        "name",
        "gender",
        "height",
        "weight",
        "measures",
        "overallFigure",
        "shoulderCollarbone",
        "chest",
        "waist",
        "hip",
        "hands",
        "legs",
        "feet",
        "hairColor",
        "hairStyle",
        "bodyHair",
        "scent",
        "sexExp",
        "meiki",
        "organ",
        "anus",
        "period",
        "painThreshold",
        "pleasureThreshold",
        "kink",
        "situationPref",
        "sexTaboo",
        "stamina",
        "exhaustion",
        "scar"
      ]
    },
    "4": {
      "aliasToIndex": {
        "name": 0,
        "coord": 1,
        "departure": 2,
        "head": 3,
        "outerUpper": 4,
        "innerUpper": 5,
        "neck": 6,
        "outerLower": 7,
        "innerLower": 8,
        "legCover": 9,
        "feet": 10,
        "legRestraint": 11,
        "holding": 12,
        "posture": 13,
        "distance": 14,
        "surfaceMask": 15,
        "leak": 16,
        "disguise": 17
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "coord"
        ],
        "2": [
          "departure"
        ],
        "3": [
          "head"
        ],
        "4": [
          "outerUpper"
        ],
        "5": [
          "innerUpper"
        ],
        "6": [
          "neck"
        ],
        "7": [
          "outerLower"
        ],
        "8": [
          "innerLower"
        ],
        "9": [
          "legCover"
        ],
        "10": [
          "feet"
        ],
        "11": [
          "legRestraint"
        ],
        "12": [
          "holding"
        ],
        "13": [
          "posture"
        ],
        "14": [
          "distance"
        ],
        "15": [
          "surfaceMask"
        ],
        "16": [
          "leak"
        ],
        "17": [
          "disguise"
        ]
      },
      "aliases": [
        "name",
        "coord",
        "departure",
        "head",
        "outerUpper",
        "innerUpper",
        "neck",
        "outerLower",
        "innerLower",
        "legCover",
        "feet",
        "legRestraint",
        "holding",
        "posture",
        "distance",
        "surfaceMask",
        "leak",
        "disguise"
      ]
    },
    "5": {
      "aliasToIndex": {
        "from": 0,
        "to": 1,
        "surfaceRel": 2,
        "surfaceCall": 3,
        "privateRel": 4,
        "privateCall": 5,
        "affection": 6,
        "obedience": 7,
        "possess": 8,
        "blind": 9,
        "guard": 10,
        "memory": 11
      },
      "indexToAliases": {
        "0": [
          "from"
        ],
        "1": [
          "to"
        ],
        "2": [
          "surfaceRel"
        ],
        "3": [
          "surfaceCall"
        ],
        "4": [
          "privateRel"
        ],
        "5": [
          "privateCall"
        ],
        "6": [
          "affection"
        ],
        "7": [
          "obedience"
        ],
        "8": [
          "possess"
        ],
        "9": [
          "blind"
        ],
        "10": [
          "guard"
        ],
        "11": [
          "memory"
        ]
      },
      "aliases": [
        "from",
        "to",
        "surfaceRel",
        "surfaceCall",
        "privateRel",
        "privateCall",
        "affection",
        "obedience",
        "possess",
        "blind",
        "guard",
        "memory"
      ]
    },
    "6": {
      "aliasToIndex": {
        "grandGoal": 0,
        "grandProgress": 1,
        "chapter": 2,
        "chapterStatus": 3,
        "focus": 4,
        "focusFeedback": 5
      },
      "indexToAliases": {
        "0": [
          "grandGoal"
        ],
        "1": [
          "grandProgress"
        ],
        "2": [
          "chapter"
        ],
        "3": [
          "chapterStatus"
        ],
        "4": [
          "focus"
        ],
        "5": [
          "focusFeedback"
        ]
      },
      "aliases": [
        "grandGoal",
        "grandProgress",
        "chapter",
        "chapterStatus",
        "focus",
        "focusFeedback"
      ]
    },
    "7": {
      "aliasToIndex": {
        "name": 0,
        "category": 1,
        "goal": 2,
        "location": 3,
        "members": 4,
        "issuer": 5,
        "assets": 6,
        "deadline": 7,
        "rule": 8,
        "progress": 9
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "category"
        ],
        "2": [
          "goal"
        ],
        "3": [
          "location"
        ],
        "4": [
          "members"
        ],
        "5": [
          "issuer"
        ],
        "6": [
          "assets"
        ],
        "7": [
          "deadline"
        ],
        "8": [
          "rule"
        ],
        "9": [
          "progress"
        ]
      },
      "aliases": [
        "name",
        "category",
        "goal",
        "location",
        "members",
        "issuer",
        "assets",
        "deadline",
        "rule",
        "progress"
      ]
    },
    "8": {
      "aliasToIndex": {
        "name": 0,
        "host": 1,
        "source": 2,
        "category": 3,
        "performance": 4,
        "severity": 5,
        "intervention": 6,
        "statMod": 7,
        "visibility": 8,
        "remaining": 9,
        "removeCond": 10
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "host"
        ],
        "2": [
          "source"
        ],
        "3": [
          "category"
        ],
        "4": [
          "performance"
        ],
        "5": [
          "severity"
        ],
        "6": [
          "intervention"
        ],
        "7": [
          "statMod"
        ],
        "8": [
          "visibility"
        ],
        "9": [
          "remaining"
        ],
        "10": [
          "removeCond"
        ]
      },
      "aliases": [
        "name",
        "host",
        "source",
        "category",
        "performance",
        "severity",
        "intervention",
        "statMod",
        "visibility",
        "remaining",
        "removeCond"
      ]
    },
    "9": {
      "aliasToIndex": {
        "name": 0,
        "holder": 1,
        "category": 2,
        "durability": 3,
        "volume": 4,
        "rarity": 5,
        "damageArmor": 6,
        "attrBonus": 7,
        "legality": 8,
        "state": 9,
        "hidden": 10,
        "storyBind": 11
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "holder"
        ],
        "2": [
          "category"
        ],
        "3": [
          "durability"
        ],
        "4": [
          "volume"
        ],
        "5": [
          "rarity"
        ],
        "6": [
          "damageArmor"
        ],
        "7": [
          "attrBonus"
        ],
        "8": [
          "legality"
        ],
        "9": [
          "state"
        ],
        "10": [
          "hidden"
        ],
        "11": [
          "storyBind"
        ]
      },
      "aliases": [
        "name",
        "holder",
        "category",
        "durability",
        "volume",
        "rarity",
        "damageArmor",
        "attrBonus",
        "legality",
        "state",
        "hidden",
        "storyBind"
      ]
    },
    "10": {
      "aliasToIndex": {
        "name": 0,
        "type": 1,
        "desc": 2,
        "origin": 3,
        "mastery": 4,
        "mpCost": 5,
        "spCost": 6,
        "baseDamage": 7,
        "cooldown": 8,
        "range": 9,
        "threshold": 10,
        "seal": 11
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "type"
        ],
        "2": [
          "desc"
        ],
        "3": [
          "origin"
        ],
        "4": [
          "mastery"
        ],
        "5": [
          "mpCost"
        ],
        "6": [
          "spCost"
        ],
        "7": [
          "baseDamage"
        ],
        "8": [
          "cooldown"
        ],
        "9": [
          "range"
        ],
        "10": [
          "threshold"
        ],
        "11": [
          "seal"
        ]
      },
      "aliases": [
        "name",
        "type",
        "desc",
        "origin",
        "mastery",
        "mpCost",
        "spCost",
        "baseDamage",
        "cooldown",
        "range",
        "threshold",
        "seal"
      ]
    },
    "11": {
      "aliasToIndex": {
        "name": 0,
        "type": 1,
        "leader": 2,
        "territory": 3,
        "reputation": 4,
        "hostility": 5,
        "benefits": 6,
        "redline": 7,
        "surveillance": 8,
        "punishment": 9
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "type"
        ],
        "2": [
          "leader"
        ],
        "3": [
          "territory"
        ],
        "4": [
          "reputation"
        ],
        "5": [
          "hostility"
        ],
        "6": [
          "benefits"
        ],
        "7": [
          "redline"
        ],
        "8": [
          "surveillance"
        ],
        "9": [
          "punishment"
        ]
      },
      "aliases": [
        "name",
        "type",
        "leader",
        "territory",
        "reputation",
        "hostility",
        "benefits",
        "redline",
        "surveillance",
        "punishment"
      ]
    },
    "12": {
      "aliasToIndex": {
        "name": 0,
        "timeRange": 1,
        "route": 2,
        "summary": 3,
        "deaths": 4,
        "factionChanges": 5,
        "assets": 6,
        "emotional": 7,
        "territory": 8,
        "suspense": 9
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "timeRange"
        ],
        "2": [
          "route"
        ],
        "3": [
          "summary"
        ],
        "4": [
          "deaths"
        ],
        "5": [
          "factionChanges"
        ],
        "6": [
          "assets"
        ],
        "7": [
          "emotional"
        ],
        "8": [
          "territory"
        ],
        "9": [
          "suspense"
        ]
      },
      "aliases": [
        "name",
        "timeRange",
        "route",
        "summary",
        "deaths",
        "factionChanges",
        "assets",
        "emotional",
        "territory",
        "suspense"
      ]
    },
    "13": {
      "aliasToIndex": {
        "name": 0,
        "hp": 1,
        "maxHp": 2,
        "mp": 3,
        "maxMp": 4,
        "sp": 5,
        "maxSp": 6,
        "str": 7,
        "con": 8,
        "dex": 9,
        "int": 10,
        "atk": 11,
        "def": 12,
        "matk": 13,
        "mdef": 14,
        "agi": 15,
        "load": 16,
        "maxLoad": 17,
        "tempMod": 18,
        "timestamp": 19
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "hp"
        ],
        "2": [
          "maxHp"
        ],
        "3": [
          "mp"
        ],
        "4": [
          "maxMp"
        ],
        "5": [
          "sp"
        ],
        "6": [
          "maxSp"
        ],
        "7": [
          "str"
        ],
        "8": [
          "con"
        ],
        "9": [
          "dex"
        ],
        "10": [
          "int"
        ],
        "11": [
          "atk"
        ],
        "12": [
          "def"
        ],
        "13": [
          "matk"
        ],
        "14": [
          "mdef"
        ],
        "15": [
          "agi"
        ],
        "16": [
          "load"
        ],
        "17": [
          "maxLoad"
        ],
        "18": [
          "tempMod"
        ],
        "19": [
          "timestamp"
        ]
      },
      "aliases": [
        "name",
        "hp",
        "maxHp",
        "mp",
        "maxMp",
        "sp",
        "maxSp",
        "str",
        "con",
        "dex",
        "int",
        "atk",
        "def",
        "matk",
        "mdef",
        "agi",
        "load",
        "maxLoad",
        "tempMod",
        "timestamp"
      ]
    },
    "14": {
      "aliasToIndex": {
        "name": 0,
        "level": 1,
        "hp": 2,
        "maxHp": 3,
        "mp": 4,
        "maxMp": 5,
        "sp": 6,
        "maxSp": 7,
        "str": 8,
        "con": 9,
        "dex": 10,
        "int": 11,
        "growth": 12,
        "atk": 13,
        "def": 14,
        "matk": 15,
        "mdef": 16,
        "agi": 17,
        "skillPool": 18,
        "drops": 19,
        "status": 20,
        "desc": 21
      },
      "indexToAliases": {
        "0": [
          "name"
        ],
        "1": [
          "level"
        ],
        "2": [
          "hp"
        ],
        "3": [
          "maxHp"
        ],
        "4": [
          "mp"
        ],
        "5": [
          "maxMp"
        ],
        "6": [
          "sp"
        ],
        "7": [
          "maxSp"
        ],
        "8": [
          "str"
        ],
        "9": [
          "con"
        ],
        "10": [
          "dex"
        ],
        "11": [
          "int"
        ],
        "12": [
          "growth"
        ],
        "13": [
          "atk"
        ],
        "14": [
          "def"
        ],
        "15": [
          "matk"
        ],
        "16": [
          "mdef"
        ],
        "17": [
          "agi"
        ],
        "18": [
          "skillPool"
        ],
        "19": [
          "drops"
        ],
        "20": [
          "status"
        ],
        "21": [
          "desc"
        ]
      },
      "aliases": [
        "name",
        "level",
        "hp",
        "maxHp",
        "mp",
        "maxMp",
        "sp",
        "maxSp",
        "str",
        "con",
        "dex",
        "int",
        "growth",
        "atk",
        "def",
        "matk",
        "mdef",
        "agi",
        "skillPool",
        "drops",
        "status",
        "desc"
      ]
    }
  }
};

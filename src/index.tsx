import { Context, Schema } from "koishi";
import { } from "koishi-plugin-adapter-onebot";
import { queries } from "./graphql";
import { wikiInfo, wikitApiRequest } from "./lib";

import type { Event } from "@satorijs/protocol";
import type { Argv, h, Session } from "koishi";
import type { Article, AuthorRank, TitleQueryResponse, UserQueryResponse, UserRankQueryResponse } from "./types";

declare module "koishi" {
  interface Tables {
    wikitQuerier: WikitQuerierTable;
  }
}

interface WikitQuerierTable {
  id?: number;
  platform: string;
  channelId: string;
  defaultwiki: string;
}

export const name: string = "wikit-querier";

export const inject: string[] = ["database"];

export interface Config {
  bannedUsers: string[];
  bannedTitles: string[];
  bannedTags: string[];
}

export const Config: Schema<Config> = Schema.object({
  bannedUsers: Schema.array(Schema.string()).description("禁止查询的用户列表"),
  bannedTitles: Schema.array(Schema.string()).description("禁止查询的文章列表"),
  bannedTags: Schema.array(Schema.string()).description("禁止查询的标签列表"),
}).description("禁止查询配置");

export function apply(ctx: Context, config: Config): void {
  ctx.model.extend("wikitQuerier", {
    id: "unsigned",
    platform: "string(64)",
    channelId: "string(64)",
    defaultwiki: "string(64)",
  });

  const normalizeUrl = (url: string): string =>
    url
      .replace(/^https?:\/\/backrooms-wiki-cn.wikidot.com/, "https://brcn.backroomswiki.cn")
      .replace(/^https?:\/\/scp-wiki-cn.wikidot.com/, "https://scpcn.backroomswiki.cn")
      .replace(/^https?:\/\/([a-z]+-wiki-cn|nationarea)/, "https://$1");

  const getDefaultwiki = async (session: Session): Promise<string | undefined> => {
    const platform = session.event.platform;
    const channelId = session.event.channel.id;

    const data = await ctx.database.get("wikitQuerier", {
      platform,
      channelId,
    });

    if (data.length > 0) {
      return data[0].defaultwiki;
    }

    return undefined;
  };
  // const getwikiUrl = async (
  //   wiki: string | undefined,
  //   lastStr: string | undefined,
  //   { platform, channel: { id: channelId } }: Event,
  // ): Promise<string> => {
  //   const wikiUrls: CromQuerierTable[] = await ctx.database.get("cromQuerier", { platform, channelId });
  //   if (Object.keys(wikiInfo).includes(lastStr)) {
  //     return wikiInfo[lastStr].url;
  //   } else if (wiki && Object.keys(wikiInfo).includes(wiki)) {
  //     return wikiInfo[wiki].url;
  //   } else if (wikiUrls.length > 0) {
  //     return wikiInfo[wikiUrls[0].defaultwiki].url;
  //   } else {
  //     return wikiInfo.cn.url;
  //   }
  // };

  let cmd = ctx
  cmd
    .command("wikitre", "修改版作者及页面信息查询")

  cmd
    .command("wikitre.about", "此插件的相关信息。")
    .alias("wikitre-about")
    .action(async (argv: Argv): Promise<string> => {
      return (
        <template>
          <quote id={argv.session.event.message.id} />
          此组件由 lestday233 基于 Wikit API 编写，修改自 https://github.com/Laimuslime/koishi-plugin-crom-querier-modified
        </template>
      );
    });

  cmd
    .command("wikitre.suppost-list", "列出所有支持的网站及对应的地址。")
    .alias("wikitre-list")
    .alias("wikitre.list")
    .action(async (argv: Argv): Promise<string> => {
      const entries = Object.entries(wikiInfo);
      if (entries.length === 0) return "当前没有配置任何维基信息。";

      const lines = entries.map(([key, value]) => `${key} → https://${value.wiki}.wikidot.com/`);
      return `支持的维基列表：\n${lines.join("\n")}`;
    });

  cmd
    .command("wikitre.default-wiki <维基名称:string>", "设置默认维基。")
    .alias("wikitre-db")
    .action(async (argv: Argv, wiki: string): Promise<string> => {
      const platform: string = argv.session.event.platform;
      const channelId: string = argv.session.event.channel.id;
      if (!wiki || !Object.keys(wikiInfo).includes(wiki) || wiki === "all") {
        return "维基名称不正确。";
      }
      ctx.database.upsert("wikitQuerier", [{ channelId, platform, defaultwiki: wiki }], ["platform", "channelId"]);
      return `已将本群默认查询维基设置为: ${wiki}`;
    });

  cmd
    .command("wikitre.author <作者:string> [维基名称:string]", "查询作者信息。默认搜索所有支持的维基。")
    .alias("wikitre-au")
    .action(async (argv: Argv, author: string, wiki: string | undefined): Promise<h> => {

      const isRankQuery: boolean = /^#[0-9]{1,15}$/.test(author);
      const rankNumber: number | null = isRankQuery ? Number(author.slice(1)) : null;
      let queryString: string = isRankQuery ? queries.userRankQuery : queries.userQuery;

      // 1. 识别全站查询参数 all
      const validwikies = ["all", ...Object.keys(wikiInfo)];
      const authorName: string =
        (wiki && !validwikies.includes(wiki)) || !author ?
          validwikies.includes(argv.args.at(-1)) ?
            argv.args.slice(0, -1).join(" ")
            : argv.args.join(" ")
          : author;

      // 2. User 渲染组件（这里的 object 是参数，绝不能丢）
      const User = ({ object }: { object: UserQueryResponse & UserRankQueryResponse }): h => {
        const dataArray: AuthorRank[] = object.authorRanking ?
          object.authorRanking
          : object.authorGlobalRank ? [object.authorGlobalRank]
            : object.authorWikiRank ? [object.authorWikiRank] : [];

        if (!dataArray || dataArray.length === 0) {
          return <template>未找到用户。</template>;
        }

        let user: AuthorRank | undefined;
        if (rankNumber !== null) {
          user = dataArray.find(
            (u) =>
              u.rank === rankNumber &&
              !config.bannedUsers.includes(u.name)
          );
        } else {
          user = dataArray.find(
            (u) =>
              !config.bannedUsers.includes(u.name)
          );
        }
        if (!user) {
          return <template>未找到用户。</template>;
        }

        // 算出页面数和平均分
        const total = object.articles?.pageInfo?.total ?? "未知";

        let average: string | number = "未知";
        if (typeof total === "number" && total > 0) {
          average = (user.value / total).toFixed(2);
        } else if (total === 0) {
          average = 0;
        }

        return (
          <template>
            <quote id={argv.session.event.message.id} />
            🔍 {user.name} (#{user.rank})
            <br />
            ⭐ 总分：{user.value} | 📑 页面数：{total} | 📈 平均分：{average}
          </template>
        );
      };

      // 3. 发送请求与拦截处理
      try {
        let finalwiki = wiki;
        if (!finalwiki) {
          finalwiki = await getDefaultwiki(argv.session);
        }

        // 切换到全站查询
        if (!finalwiki || finalwiki === "all") {
          // 👇 加了判断：如果是查排名，继续用排名的 Query 拿全站排行榜；如果是查名字，再切换
          queryString = isRankQuery ? queries.userRankQuery : queries.userGlobalQuery;
          finalwiki = "all";
        }

        let result = await wikitApiRequest(authorName, finalwiki, 0, queryString);

        // 如果是查排名，偷偷发二次请求把页面数补齐
        if (isRankQuery && (result as UserRankQueryResponse).authorRanking) {
          const rankData = result as UserRankQueryResponse;
          const matchedUser = rankData.authorRanking.find(
            (u) => u.rank === rankNumber && !config.bannedUsers.includes(u.name)
          );
          if (matchedUser) {
            // 查排名时，根据是否是全站自动切换查询语法
            let secondQuery = (!finalwiki || finalwiki === "all") ? queries.userGlobalQuery : queries.userQuery;
            result = await wikitApiRequest(matchedUser.name, finalwiki, 0, secondQuery);
          }
        }

        const response = <User object={result as UserQueryResponse & UserRankQueryResponse} />;

        const sentMessages = await argv.session.send(response);
        scheduleChecks(0, argv.session, sentMessages[0]);

        return;
      } catch (err) {
        return <template>查询失败: {err.message || "未知错误"}</template>;
      }
    });

  cmd
    .command("wikitre.search <标题:string> [维基名称:string]", "查询文章信息。默认搜索所有支持的维基。")
    .alias("wikitre-sr")
    .action(async (argv: Argv, title: string, wiki: string | undefined): Promise<h> => {
      // const wikiUrl = await getwikiUrl(wiki, argv.args.at(-1), argv.session.event);
      const titleName: string =
        (wiki && !Object.keys(wikiInfo).includes(wiki)) || !title ?
          Object.keys(wikiInfo).includes(argv.args.at(-1)) ?
            argv.args.slice(0, -1).join(" ")
            : argv.args.join(" ")
          : title;

      const Author = ({ authorName }: { authorName: string }): h => {
        return <template>🔍作者：{authorName || "已注销用户"}</template>;
      };

      const TitleProceed = ({ titleData }: { titleData: TitleQueryResponse }): h => {
        const articles: Article[] = titleData?.articles?.nodes;
        if (!articles || articles.length === 0) {
          return <template>未找到文章。</template>;
        }

        const selectedIndex: number = articles.findIndex((article: Article): boolean => {
          const isBannedTitle: boolean = config.bannedTitles.includes(article.title);
          const isBannedUser: boolean = config.bannedUsers.includes(article.author);
          return !(isBannedTitle || isBannedUser);
        });

        if (selectedIndex === -1) {
          return <template>未找到符合条件的文章。</template>;
        }

        const article: Article = articles[selectedIndex];

        return (
          <template>
            <quote id={argv.session.event.message.id} />
            📝页面：{article.title}
            <br />
            ⭐评分：{article.rating}
            <br />
            <Author authorName={article.author} />
            <br />
            🔗{normalizeUrl(article.url)}
          </template>
        );
      };

      try {
        let finalwiki = wiki;
        if (!finalwiki) {
          finalwiki = await getDefaultwiki(argv.session);
        }
        const result = await wikitApiRequest(titleName, wiki, 0, queries.titleQuery);
        const response: h = <TitleProceed titleData={result as TitleQueryResponse} />;

        const sentMessages = await argv.session.send(response);
        scheduleChecks(0, argv.session, sentMessages[0]);

        return;
      } catch (err) {
        return <template>查询失败：{err.message || "未知错误"}</template>;
      }
    });

  const checkTimes = [10000, 30000, 60000, 90000, 11000, 12000];

  const checkAndDelete = async (session: Session, sentMessage: string): Promise<boolean> => {
    try {
      const message = await session.onebot.getMsg(session.messageId);

      if ((message as unknown as { raw_message: string })?.raw_message === "") {
        await session.onebot.deleteMsg(sentMessage);
        return true;
      }
      return false;
    } catch (error) {
      ctx.logger("wikit-querier").warn("检测或撤回消息失败:", error);
      return false;
    }
  };

  const scheduleChecks = (index: number, session: Session, sentMessage: string): void => {
    if (index >= checkTimes.length) return;

    ctx.setTimeout(
      async (): Promise<void> => {
        const deleted = await checkAndDelete(session, sentMessage);
        if (!deleted) {
          scheduleChecks(index + 1, session, sentMessage);
        }
      },
      index === 0 ? checkTimes[0] : checkTimes[index] - checkTimes[index - 1],
    );
  };
}
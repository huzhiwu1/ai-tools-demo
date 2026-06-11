# 官方 ES 基础镜像
FROM elasticsearch:8.17.0

# 安装 IK 中文分词插件（版本必须和 ES 镜像版本严格一致，否则启动报错）
RUN elasticsearch-plugin install --batch \
    https://release.infinilabs.com/analysis-ik/stable/elasticsearch-analysis-ik-8.17.0.zip

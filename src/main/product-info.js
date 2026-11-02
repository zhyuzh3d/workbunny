'use strict';

const REPOSITORY = 'https://github.com/zhyuzh3d/workbunny';
function productInfo(version) {
  return {
    name: 'WorkBunny', subtitle: '工作伴侣', author: 'zhyuzh3d（微信同号）', version,
    repository: REPOSITORY, repositoryLabel: 'zhyuzh3d/workbunny',
    source: '开源软件', license: 'MIT License',
    description: '陪你聊天、记住相处，也协助处理工作。',
    licenseNote: '程序代码采用 MIT 许可，允许使用、修改与分发，须保留版权和许可声明。第三方模型、动作、依赖及商标遵循各自许可。',
  };
}
module.exports = { REPOSITORY, productInfo };

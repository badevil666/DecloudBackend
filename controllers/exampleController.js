// Example controller structure
// This is a template for creating controllers

const exampleFunction = async (req, res, next) => {
  try {
    // Your logic here
    res.json({
      success: true,
      message: 'Example response',
      data: {}
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  exampleFunction
};


